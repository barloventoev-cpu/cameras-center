import { Router } from "express";
import { cloudinaryUsage, parseCloudinaryUrl } from "@cameras/core";
import { requireAuth } from "../middleware/auth";
import { eventCount } from "../events";
import { retentionStatus, runRetention } from "../retention";
import { agentDisk } from "../ws/gateway";

/**
 * Almacenamiento: cuánto ocupan los eventos/fotos/clips y purga manual.
 *
 * - `GET  /api/v1/storage`       uso (Cloudinary con caché de 5 min, filas
 *   de eventos, disco local del agent, estado de retención). Sólo JWT.
 * - `POST /api/v1/storage/purge` ejecuta la purga de retención ahora
 *   (sólo owner). Devuelve lo borrado.
 */
export const storageRouter = Router();

function handleError(res: import("express").Response, error: unknown, context: string) {
  console.error(`[storage] ${context}:`, error);
  return res.status(500).json({ error: error instanceof Error ? error.message : "Error interno" });
}

let usageCache: { at: number; data: { storageUsedBytes: number; storageLimitBytes: number } } | null = null;
const USAGE_TTL_MS = 5 * 60_000;

async function cloudinaryUsageCached(): Promise<
  | { configured: false }
  | { configured: true; storageUsedBytes: number; storageLimitBytes: number }
> {
  const creds = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
  if (!creds) return { configured: false };
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) {
    return { configured: true, ...usageCache.data };
  }
  const data = await cloudinaryUsage(creds);
  usageCache = { at: Date.now(), data };
  return { configured: true, ...data };
}

storageRouter.get("/", requireAuth, async (_req, res) => {
  try {
    const [cloudinary, motion, clips, thumbnails] = await Promise.all([
      cloudinaryUsageCached(),
      eventCount("motion").catch(() => 0),
      eventCount("clip").catch(() => 0),
      eventCount("thumbnail").catch(() => 0),
    ]);
    res.json({
      cloudinary,
      events: { motion, clips, thumbnails, total: motion + clips + thumbnails },
      agent: { ...agentDisk },
      retention: {
        enabled: retentionStatus.enabled,
        daysEvents: retentionStatus.daysEvents,
        daysAssets: retentionStatus.daysAssets,
        lastRun: retentionStatus.lastRun,
        lastDeletedEvents: retentionStatus.lastDeletedEvents,
        lastDeletedAssets: retentionStatus.lastDeletedAssets,
        lastFailures: retentionStatus.lastFailures,
      },
    });
  } catch (error) {
    handleError(res, error, "usage");
  }
});

storageRouter.post("/purge", requireAuth, async (req, res) => {
  if (res.locals.userRole !== "owner") {
    return res.status(403).json({ error: "Sólo el usuario owner puede purgar" });
  }
  try {
    const result = await runRetention("manual");
    res.json({
      purge: result,
      retention: {
        enabled: retentionStatus.enabled,
        daysEvents: retentionStatus.daysEvents,
        daysAssets: retentionStatus.daysAssets,
        lastRun: retentionStatus.lastRun,
      },
    });
  } catch (error) {
    handleError(res, error, "purge");
  }
});
