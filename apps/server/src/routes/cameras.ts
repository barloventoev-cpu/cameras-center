import { Router } from "express";
import { z } from "zod";
import { CreateCameraSchema, EncodingSchema } from "@cameras/protocol";
import { store, toPublicCamera } from "../store";
import { requireAuth, requirePrincipal } from "../middleware/auth";
import { principalRateLimit } from "../middleware/rateLimit";
import { captureThumb, latestThumbnails } from "../thumbs";
import { frameCache, type CachedFrame } from "../ws/frames";

/**
 * Registro de cámaras.
 *  - Lectura: pública (la UI y los viewers la necesitan sin token), salvo las
 *    de imagen (frame.jpg / thumbnails / stream), que sí aceptan JWT o API key.
 *  - Escritura: requiere JWT (F2).
 *  - Persistencia: Supabase si está configurado, si no memoria.
 */
export const camerasRouter = Router();

function handleError(res: import("express").Response, error: unknown, context: string) {
  console.error(`[cameras] ${context}:`, error);
  const message = error instanceof Error ? error.message : "Error interno";
  if (res.headersSent) return res.end(); // p.ej. fallo a mitad del stream MJPEG
  return res.status(500).json({ error: message });
}

camerasRouter.get("/", async (_req, res) => {
  try {
    const cameras = await store.list();
    res.json({ cameras: cameras.map(toPublicCamera), backend: store.backend });
  } catch (error) {
    handleError(res, error, "list");
  }
});

/**
 * Último frame (JPEG) recibido por relay — F3/F5.
 *
 * Sirve de API pública / fallback para quien no pueda abrir WebSocket: no es
 * vídeo, es una foto en el instante de la petición. Acepta JWT de usuario o
 * API key con scope `read` porque expone la imagen fuera de la LAN.
 *
 * Ojo con la foto vieja: con el agent apagado la caché conserva el último JPEG
 * y reenviarlo sería una "imagen fantasma" (el integrador vería vídeo donde ya
 * no lo hay). Por eso `FRAME_MAX_AGE_MS` (60 s por defecto, configurable) la
 * sustituye por un 404 con `X-Frame-Age-Ms`, para que el consumidor pueda
 * decir "sin señal" en lugar de pintar la foto caducada.
 */
const FRAME_MAX_AGE_MS = (() => {
  const raw = Number(process.env.FRAME_MAX_AGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

camerasRouter.get("/:id/frame.jpg", requirePrincipal, principalRateLimit, async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "Falta el id" });
  try {
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });

    const frame = frameCache.get(id);
    if (!frame) {
      return res.status(404).json({
        error: "Sin frames recientes: abre la camara en la app para que el agent arranque",
        reason: "sin-agent",
      });
    }
    const ageMs = Date.now() - frame.receivedAt;
    if (ageMs > FRAME_MAX_AGE_MS) {
      // Foto caducada: NO se envía el JPEG (sería una imagen fantasma). El
      // 404 conserva la cabecera de antigüedad por si el consumidor quiere
      // mostrar "última imagen hace Ns".
      return res
        .set("Cache-Control", "no-store")
        .set("X-Frame-Age-Ms", String(ageMs))
        .status(404)
        .json({
          error: `Sin frames recientes (último hace ${Math.round(ageMs / 1000)} s): el agent no está conectado`,
          reason: "sin-agent",
          ageMs,
        });
    }
    res
      .set("Content-Type", "image/jpeg")
      .set("Cache-Control", "no-store")
      .set("X-Frame-Age-Ms", String(ageMs))
      .send(frame.data);
  } catch (error) {
    handleError(res, error, "frame");
  }
});

/**
 * Última thumbnail (Cloudinary) de cada cámara — F4.
 * Se usa como póster estático en la UI; acepta JWT o API key igual que `frame.jpg`.
 */
camerasRouter.get("/thumbnails", requirePrincipal, principalRateLimit, async (_req, res) => {
  try {
    res.json({ thumbnails: await latestThumbnails() });
  } catch (error) {
    handleError(res, error, "thumbnails");
  }
});

/**
 * Stream MJPEG continuo — F5.
 *
 * `GET /api/v1/streams/:id.mjpg` (alias `GET /api/v1/cameras/:id/stream.mjpg`)
 * → `multipart/x-mixed-replace`. Es la forma más simple de que un tercero vea
 * vídeo: `<img src=…>`, VLC, ffmpeg o cualquier visor de MJPEG. Sin WebSocket
 * ni SDK.
 *
 * Al abrirlo el server se registra como espectador (gateway.acquire) y eso pide
 * al agent que arranque FFmpeg; al cerrarse la conexión lo suelta y, si no queda
 * nadie, el agent se apaga (AGENT_NO_VIEWER_STOP_MS).
 */
export async function streamMjpeg(req: import("express").Request, res: import("express").Response) {
  // acepta tanto `.../<id>.mjpg` como `.../<id>/stream.mjpg`
  const id = (req.params.id ?? req.params.file ?? "").replace(/\.mjpg$/i, "");
  if (!id) return res.status(400).json({ error: "Falta el id" });

  try {
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });

    const gateway = req.app.locals.gateway as
      | { acquire(cameraId: string): void; release(cameraId: string): void; stats?: () => { agents?: number } }
      | undefined;
    if (!gateway) return res.status(503).json({ error: "Relay no disponible" });
    /** Nº de agents vivos; `undefined` si el gateway no lo expone (no se rinde antes). */
    const gatewayStats = (): { agents?: number } | undefined => gateway.stats?.();

    const BOUNDARY = "frame";
    /** Sin frame nuevo en este tiempo se cierra (el cliente puede reconectar). */
    const STALL_MS = 60_000;
    /** Si no llega nada, se reenvía la última foto fresca para mantener viva la conexión. */
    const KEEPALIVE_MS = 10_000;
    /** Un frame con más edad que esto NO se pinta: sería una imagen fantasma. */
    const FRESH_MS = 15_000;
    /** Espera al primer frame antes de contestar (el agent arranca FFmpeg en ~2-5 s). */
    const STARTUP_MS = 20_000;
    /**
     * Sin ningún agent conectado no puede llegar jamás un frame: a los
     * `NO_AGENT_MS` se contesta 503 en vez de dejar al cliente colgado hasta
     * `STARTUP_MS` (los proxies intermedios abortan antes y se pierde el motivo).
     */
    const NO_AGENT_MS = 8_000;

    let closed = false;
    /** ¿Ya se enviaron las cabeceras multipart? writeHead sólo no llega al cliente. */
    let started = false;
    let lastFrameAt = Date.now();
    let lastWriteAt = Date.now();
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let noAgentTimer: ReturnType<typeof setTimeout> | undefined;

    const write = (frame: CachedFrame): void => {
      if (closed || res.writableEnded) return;
      res.write(
        `--${BOUNDARY}\r\n` +
          `Content-Type: image/jpeg\r\n` +
          `Content-Length: ${frame.data.length}\r\n` +
          `X-Seq: ${frame.header.seq}\r\n\r\n`,
      );
      res.write(frame.data);
      res.write("\r\n");
      lastWriteAt = Date.now();
    };

    /**
     * Abre el stream multipart. Las cabeceras NO se envían hasta que hay
     * imagen real que pintar: un `writeHead()` sin `write()` no sale del
     * servidor y el cliente se quedaría esperando para siempre.
     */
    const start = (): void => {
      if (started || closed) return;
      started = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (noAgentTimer) clearTimeout(noAgentTimer);
      res.writeHead(200, {
        "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      lastWriteAt = Date.now();
      watchdog = setInterval(() => {
        const now = Date.now();
        if (now - lastFrameAt > STALL_MS) {
          cleanup();
          if (!res.writableEnded) res.end();
          return;
        }
        if (now - lastWriteAt > KEEPALIVE_MS) {
          const cached = frameCache.get(id);
          if (cached && Date.now() - cached.receivedAt <= FRESH_MS) write(cached);
        }
      }, 5_000);
    };

    const off = frameCache.on(id, (frame) => {
      start();
      lastFrameAt = Date.now();
      write(frame);
    });
    gateway.acquire(id);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (noAgentTimer) clearTimeout(noAgentTimer);
      if (watchdog) clearInterval(watchdog);
      off();
      gateway.release(id);
    };

    /** Rinde la conexión sin imagen: 503 con motivo, nunca una respuesta muda. */
    const failNoSignal = (reason: "sin-agent" | "sin-signal", error: string): void => {
      if (started || closed) return;
      cleanup();
      if (!res.headersSent) res.status(503).json({ error, reason });
    };

    // Sin imagen fresca se espera al primer frame (arranque del agent). Si no
    // llega, se contesta 503: la conexión muda era peor que un error, el
    // cliente se quedaba mirando una pantalla que nunca se pintaría.
    startupTimer = setTimeout(() => {
      const agents = gatewayStats()?.agents;
      const anyAgent = typeof agents === "number" && agents > 0;
      failNoSignal(
        anyAgent ? "sin-signal" : "sin-agent",
        anyAgent
          ? "Sin frames recientes: el agent está conectado pero no envía vídeo"
          : "Sin frames recientes: el agent no está conectado",
      );
    }, STARTUP_MS);

    // Si no hay NADIE en la sala de agents, no va a llegar ningún frame: se
    // contesta antes para que un proxy intermedio pueda reenviar el motivo.
    noAgentTimer = setTimeout(() => {
      if (gatewayStats()?.agents === 0) {
        failNoSignal("sin-agent", "Sin agent conectado: nadie puede enviar vídeo de esta cámara");
      }
    }, NO_AGENT_MS);

    // Primer pintado inmediato con lo que haya en caché (no hay que esperar al
    // siguiente frame del agent, que puede tardar mientras FFmpeg arranca).
    // Sólo si el frame es fresco: una foto vieja (agent apagado) engañaría al
    // cliente mostrando vídeo donde ya no lo hay.
    const initial = frameCache.get(id);
    if (initial && Date.now() - initial.receivedAt <= FRESH_MS) {
      start();
      write(initial);
      lastFrameAt = initial.receivedAt;
    }

    req.on("close", cleanup);
    res.on("close", cleanup);
    req.on("error", cleanup);
  } catch (error) {
    handleError(res, error, "stream.mjpg");
  }
}

camerasRouter.get("/:id/stream.mjpg", requirePrincipal, principalRateLimit, streamMjpeg);

/** Ruta canónica documentada en F5: `/api/v1/streams/<id>.mjpg`. */
export const streamsRouter = Router();
streamsRouter.get("/:file", requirePrincipal, principalRateLimit, streamMjpeg);

/**
 * Captura un thumbnail AHORA (saltándose el rate limit automático) — F4.
 * Devuelve la URL de Cloudinary o un error accionable si no hay imagen.
 */
camerasRouter.post("/:id/thumbnail", requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "Falta el id" });
  try {
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });

    const outcome = await captureThumb(id, true);
    if (outcome.ok) {
      return res.json({ thumbnail: { url: outcome.url, publicId: outcome.publicId, bytes: outcome.bytes, ageMs: outcome.ageMs } });
    }

    const status =
      outcome.reason === "sin-configurar" ? 503 : outcome.reason === "fallo" ? 502 : outcome.reason === "en-curso" ? 409 : 409;
    return res.status(status).json({
      error: outcome.message ?? "No se pudo generar la thumbnail",
      reason: outcome.reason,
      ageMs: outcome.ageMs,
    });
  } catch (error) {
    handleError(res, error, "capture-thumb");
  }
});

/** F7: cuerpo opcional de `POST /:id/clip`. */
const ClipRequestSchema = z
  .object({ durationMs: z.number().int().min(1000).max(60_000).optional() })
  .default({});

/**
 * Pide al agent que grabe un clip MP4 — F7.
 *
 * Sólo JWT (como el resto de escrituras). El agent graba `-t N` con `-c:v copy`,
 * sube el MP4 a Cloudinary y contesta con `agent:clipReady`: el server lo pega
 * en el aviso reciente de esa cámara o, si no lo hay, crea un evento `type=clip`.
 * El `202` sólo significa «pedido»: la grabación es asíncrona.
 */
camerasRouter.post("/:id/clip", requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "Falta el id" });

  const parsed = ClipRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Payload invalido", issues: parsed.error.issues });
  }

  try {
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });

    const gateway = req.app.locals.gateway as
      | { requestClip(cameraId: string, durationMs?: number): boolean }
      | undefined;
    if (!gateway) return res.status(503).json({ error: "Relay no disponible" });

    const durationMs = parsed.data.durationMs;
    if (!gateway.requestClip(id, durationMs)) {
      return res.status(409).json({ error: "Sin agent conectado: no se puede grabar", reason: "sin-agent" });
    }

    res.status(202).json({
      clip: {
        cameraId: id,
        durationMs: durationMs ?? null,
        requestedAt: Date.now(),
        note: "Al terminar llega un evento type=clip (o se pega al aviso reciente de la cámara).",
      },
    });
  } catch (error) {
    handleError(res, error, "record-clip");
  }
});

/** Codificación por cámara (resolución/FPS del panel del admin). */
const EncodingRequestSchema = EncodingSchema;

type EncodingGateway = {
  requestEncoding(cameraId: string, width: number, fps: number): boolean;
  lastEncoding(
    cameraId: string
  ): { width: number; fps: number; measuredFps?: number } | undefined;
  stats(): { agents: number };
};

/**
 * Codificación actual de la cámara (lo último reportado por el agent; por
 * defecto 640 px @ 2 fps). Acepta API key porque TuQuotaAdmin la llama con la
 * clave de integración que guarda en su backend (nunca llega al navegador).
 */
camerasRouter.get("/:id/encoding", requirePrincipal, principalRateLimit, async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "Falta el id" });
  try {
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });

    const gateway = req.app.locals.gateway as EncodingGateway | undefined;
    const reported = gateway?.lastEncoding(id);
    const width = reported?.width ?? 640;
    const fps = reported?.fps ?? 2;
    const emitted = frameCache.emitted(id);
    res.json({
      cameraId: id,
      width,
      fps,
      /**
       * Fotogramas por segundo realmente medidos en el stream. Si no se
       * acercan a `fps`, el FFmpeg en marcha no está emitiendo lo configurado
       * (p. ej. sigue con la codificación anterior hasta su próximo reinicio):
       * el panel lo muestra para que la configuración no pueda "parecer"
       * aplicada sin serlo.
       */
      measuredFps: reported?.measuredFps ?? null,
      /**
       * Resolución REAL del último fotograma cacheado (y su edad). El filtro
       * escala a `min(width, ancho de la fuente)`, así que un ancho MAYOR que
       * el configurado significa sin lugar a dudas que el FFmpeg en marcha no
       * aplicó la codificación.
       */
      emittedSize: emitted ? `${emitted.width}x${emitted.height}` : null,
      emittedAgeMs: emitted?.ageMs ?? null,
      agentConnected: (gateway?.stats()?.agents ?? 0) > 0,
      custom: width !== 640 || fps !== 2,
    });
  } catch (error) {
    handleError(res, error, "get-encoding");
  }
});

/**
 * Cambia resolución/FPS de una cámara: el agent reinicia su FFmpeg (corte
 * breve de ~2-5 s) y confirma en su próximo reporte de estado (~10 s). Sin
 * agent conectado responde 409 (igual que los clips).
 */
camerasRouter.patch("/:id/encoding", requirePrincipal, principalRateLimit, async (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: "Falta el id" });

  const parsed = EncodingRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Payload invalido", issues: parsed.error.issues });
  }

  try {
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });

    const gateway = req.app.locals.gateway as EncodingGateway | undefined;
    if (!gateway) return res.status(503).json({ error: "Relay no disponible" });

    const { width, fps } = parsed.data;
    if (!gateway.requestEncoding(id, width, fps)) {
      return res.status(409).json({ error: "Sin agent conectado: no se puede aplicar", reason: "sin-agent" });
    }

    res.json({
      cameraId: id,
      width,
      fps,
      note: "Pedido enviado al agent: reinicia el FFmpeg (corte breve) y lo confirma en su próximo reporte.",
    });
  } catch (error) {
    handleError(res, error, "set-encoding");
  }
});

camerasRouter.get("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Falta el id" });
    const camera = await store.get(id);
    if (!camera) return res.status(404).json({ error: "Camara no encontrada" });
    res.json({ camera: toPublicCamera(camera) });
  } catch (error) {
    handleError(res, error, "get");
  }
});

camerasRouter.post("/", requireAuth, async (req, res) => {
  const parsed = CreateCameraSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Payload invalido", issues: parsed.error.issues });
  }
  try {
    const camera = await store.create(parsed.data, res.locals.userId);
    res.status(201).json({ camera: toPublicCamera(camera) });
  } catch (error) {
    handleError(res, error, "create");
  }
});

camerasRouter.delete("/:id", requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Falta el id" });
    const removed = await store.remove(id);
    if (!removed) return res.status(404).json({ error: "Camara no encontrada" });
    res.status(204).end();
  } catch (error) {
    handleError(res, error, "delete");
  }
});
