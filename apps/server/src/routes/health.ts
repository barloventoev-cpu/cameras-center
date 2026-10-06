import { Router } from "express";
import { API } from "@cameras/protocol";
import { config, hasSupabase } from "../config";
import { store } from "../store";
import { authInfo } from "../db/users";
import { getSchemaStatus } from "../db/supabase";
import { cloudinaryStatus, thumbCount, thumbStats } from "../thumbs";
import { clipStats, eventCount, eventStats } from "../events";
import { webhookInfo } from "../webhooks";
import { frameCache } from "../ws/frames";
import { keyStore } from "../keys";
import { authLimiter, globalLimiter, keyLimiter } from "../middleware/rateLimit";
import type { GatewayStats } from "../ws/gateway";

export const healthRouter = Router();

const rpmOf = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

healthRouter.get(API.health, async (req, res) => {
  const gateway = req.app.locals.gateway as { stats?: () => GatewayStats } | undefined;
  const gw = gateway?.stats?.();

  res.json({
    status: "ok",
    service: "cameras-center-server",
    version: config.version,
    env: config.nodeEnv,
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    storage: {
      cameras: store.backend,
      supabase: hasSupabase() ? "configured" : "pending (pega SUPABASE_SERVICE_KEY)",
      schema: hasSupabase()
        ? (getSchemaStatus()?.ok === false
            ? `faltan: ${getSchemaStatus()?.missing.join(", ")}`
            : getSchemaStatus()?.ok
              ? "ok"
              : "sin verificar")
        : "n/a (memoria)",
    },
    auth: authInfo(),
    // F3: conexiones WebSocket vivas
    ws: gw ?? { connected: 0, agents: 0, viewers: 0, cameras: [] },
    // F3: últimas imágenes recibidas (1 por cámara, sirve /frame.jpg)
    frames: { cachedCameras: frameCache.size() },
    // F4: miniaturas en Cloudinary
    cloudinary: {
      ...cloudinaryStatus(),
      status: thumbStats.uploads > 0 || (await thumbCount()) > 0 ? "ok" : "sin subidas aún",
      uploads: thumbStats.uploads,
      failures: thumbStats.failures,
      thumbnails: await thumbCount(),
      lastOkAt: thumbStats.lastOkAt ? new Date(thumbStats.lastOkAt).toISOString() : null,
      lastError: thumbStats.lastError,
    },
    integrations: {
      cloudinary: cloudinaryStatus().configured ? "configured" : "pending (define CLOUDINARY_URL)",
    },
    // F6: eventos de movimiento y webhooks registrados
    events: await eventInfo(),
    // F7: clips recibidos del agent (pegados a un aviso o como evento type=clip)
    clips: {
      received: clipStats.received,
      attached: clipStats.attached,
      created: clipStats.created,
      failures: clipStats.failures,
      lastAt: clipStats.lastAt ? new Date(clipStats.lastAt).toISOString() : null,
      lastError: clipStats.lastError,
    },
    webhooks: webhookInfo(),
    // F5: API keys de terceros + límites de peticiones
    apiKeys: await keyInfo(),
    rateLimit: {
      global: { rpm: rpmOf(process.env.RATE_LIMIT_RPM, 300), ...globalLimiter.stats() },
      auth: { rpm: rpmOf(process.env.AUTH_RATE_LIMIT_RPM, 10), ...authLimiter.stats() },
      principal: keyLimiter.stats(),
    },
  });
});

async function keyInfo() {
  try {
    const counts = await keyStore.count();
    return { backend: keyStore.backend, ...counts };
  } catch (error) {
    return { backend: keyStore.backend, error: error instanceof Error ? error.message : "error" };
  }
}

async function eventInfo() {
  return {
    type: "motion",
    total: await eventCount(),
    received: eventStats.received,
    persisted: eventStats.persisted,
    snapshots: eventStats.snapshots,
    snapshotFailures: eventStats.snapshotFailures,
    lastAt: eventStats.lastAt ? new Date(eventStats.lastAt).toISOString() : null,
    lastError: eventStats.lastError,
  };
}
