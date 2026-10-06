import { Router } from "express";
import { z } from "zod";
import { DiscoverOptionsSchema } from "@cameras/protocol";
import { requireAuth } from "../middleware/auth";
import { RateLimiter, principalRateLimit } from "../middleware/rateLimit";
import type { DiscoverOutcome } from "../ws/gateway";

/**
 * F8 — búsqueda de cámaras en la red local desde la app.
 *
 *   web ──POST /api/v1/discover──► server ──server:discover──► agent (LAN)
 *   web ◄──{ subnet, hosts[] }◄── agent:discoverResult ◄────────┘
 *
 * El server **no barre la red**: en producción vive en Render y no ve los
 * hosts privados. Sólo correlaciona la petición con la respuesta del agent
 * (mismo `requestId`) y la devuelve tal cual.
 *
 * Sólo JWT (como el resto de escrituras) y con techo propio: un barrido abre
 * miles de conexiones, no puede lanzarse a mansalva.
 */
export const discoverRouter = Router();

/** Barridos por minuto y usuario (independiente del límite global por IP). */
const discoverLimiter = new RateLimiter();
const DISCOVER_RPM = 10;

const DiscoverBodySchema = DiscoverOptionsSchema.extend({
  /** Segundos máximos de espera al agent (5..120; por defecto 60). */
  waitSec: z.number().int().min(5).max(120).optional(),
}).default({});

type DiscoverGateway = {
  requestDiscover(options: { subnet?: string; ip?: string; ports?: number[]; timeoutMs?: number; onvif: boolean }, timeoutMs?: number): Promise<DiscoverOutcome>;
};

discoverRouter.post("/", requireAuth, principalRateLimit, async (req, res) => {
  const parsed = DiscoverBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Payload invalido", issues: parsed.error.issues });
  }

  const verdict = discoverLimiter.take(`discover:${String(res.locals.userId ?? "anon")}`, DISCOVER_RPM);
  if (!verdict.allowed) {
    res.set("Retry-After", String(verdict.resetSec));
    return res.status(429).json({
      error: `Demasiadas búsquedas: máximo ${DISCOVER_RPM} por minuto`,
      retryAfterSec: verdict.resetSec,
    });
  }

  try {
    const gateway = req.app.locals.gateway as DiscoverGateway | undefined;
    if (!gateway) return res.status(503).json({ error: "Relay no disponible" });

    const { waitSec, ...options } = parsed.data;
    const outcome = await gateway.requestDiscover(options, (waitSec ?? 60) * 1000);

    if (outcome.code === "sin-agent") {
      return res.status(409).json({
        error: "Sin agent conectado: la red sólo se puede buscar desde la máquina donde corre el agent",
        reason: "sin-agent",
      });
    }
    if (outcome.code === "timeout") {
      return res.status(504).json({ error: "El agent no contestó a tiempo", reason: "timeout" });
    }
    if (outcome.code === "error") {
      return res.status(502).json({ error: outcome.message, reason: "agent" });
    }

    const { result } = outcome;
    console.log(
      `[discover] ${result.subnet || "?"}: ${result.hosts.length} host(s) de ${result.scanned} sondeados en ${result.elapsedMs} ms`,
    );
    res.json({
      discover: {
        agentId: result.agentId ?? null,
        subnet: result.subnet,
        scanned: result.scanned,
        elapsedMs: result.elapsedMs,
        hosts: result.hosts,
        at: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("[discover] error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Error interno" });
  }
});
