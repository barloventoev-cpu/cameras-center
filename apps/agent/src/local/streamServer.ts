import http from "node:http";
import { existsSync } from "node:fs";
import type { MjpegPipeline } from "../pipeline/mjpeg";
import type { PipelineRegistry } from "../pipeline/registry";
import { resolveFfmpegPath } from "../pipeline/ffmpeg";
import { devicePathOf, webcamCapture, webcamStatus } from "./webcam";

const BOUNDARY = "ffcamerasboundary";

/**
 * Servidor HTTP local del agent (por defecto :4100).
 *
 *   GET /stream/:id.mjpg   MJPEG multipart/x-mixed-replace (lo consume el navegador)
 *   GET /snapshot/:id.jpg  último frame JPEG
 *   GET /webcam.mjpg       F9: webcam local (V4L2) en vivo — sólo loopback
 *   GET /webcam.jpg        F9: último frame de la webcam — sólo loopback
 *   GET /api/status        estado de todos los pipelines
 *   GET /api/motion        F6: estado de la detección de movimiento
 *   GET /api/clips         F7: clips grabados (estadísticas y archivos locales)
 *   GET /api/webcam        F9: capturas de webcam activas
 *   GET /api/health        healthcheck
 *
 * Acceso directo desde la LAN (baja latencia). El acceso remoto pasa por el
 * server en F3, que relaya este mismo flujo.
 */
export function createStreamServer(
  registry: PipelineRegistry,
  port: number,
  motionStatus?: () => unknown,
  clipStatus?: () => unknown,
): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }

    if (url.pathname === "/api/health") {
      json(res, 200, { status: "ok", service: "cameras-center-agent", port, ffmpeg: resolveFfmpegPath() ?? null }, cors);
      return;
    }

    if (url.pathname === "/api/status") {
      json(res, 200, { cameras: registry.statuses() }, cors);
      return;
    }

    if (url.pathname === "/api/motion") {
      json(res, 200, { motion: motionStatus?.() ?? { enabled: false, cameras: [] } }, cors);
      return;
    }

    if (url.pathname === "/api/clips") {
      json(res, 200, { clips: clipStatus?.() ?? { active: [], recorded: 0 } }, cors);
      return;
    }

    if (url.pathname === "/api/webcam") {
      json(res, 200, { webcam: webcamStatus() }, cors);
      return;
    }

    if (url.pathname === "/webcam.mjpg" || url.pathname === "/webcam.jpg") {
      serveWebcam(url.pathname, res, req, url, cors);
      return;
    }

    const streamMatch = /^\/stream\/([^/]+)\.mjpg$/.exec(url.pathname);
    if (streamMatch) {
      streamMjpeg(res, registry.get(streamMatch[1] as string), cors, req);
      return;
    }

    const snapshotMatch = /^\/snapshot\/([^/]+)\.jpg$/.exec(url.pathname);
    if (snapshotMatch) {
      void sendSnapshot(res, registry.get(snapshotMatch[1] as string), cors);
      return;
    }

    json(res, 404, { error: "Ruta no encontrada", path: url.pathname }, cors);
  });

  return server;
}

function json(res: http.ServerResponse, code: number, body: unknown, cors: Record<string, string>) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors });
  res.end(payload);
}

function streamMjpeg(
  res: http.ServerResponse,
  pipeline: MjpegPipeline | undefined,
  cors: Record<string, string>,
  req: http.IncomingMessage,
) {
  if (!pipeline) {
    json(res, 404, { error: "Camara no encontrada en este agent" }, cors);
    return;
  }

  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    ...cors,
  });

  const send = (frame: Buffer) => {
    if (res.writableEnded) return;
    res.write(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    res.write(frame);
    res.write("\r\n");
  };

  const unsubscribe = pipeline.subscribe(send);

  const cleanup = () => {
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

async function sendSnapshot(
  res: http.ServerResponse,
  pipeline: MjpegPipeline | undefined,
  cors: Record<string, string>,
) {
  if (!pipeline) {
    json(res, 404, { error: "Camara no encontrada en este agent" }, cors);
    return;
  }

  // esperar hasta 4 s a que FFmpeg produzca el primer frame
  if (!pipeline.snapshot()) {
    pipeline.ensureRunning();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !pipeline.snapshot()) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const frame = pipeline.snapshot();
  if (!frame) {
    json(res, 503, { error: "Sin frame disponible", cameraId: pipeline.id, detail: pipeline.status() }, cors);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": frame.length,
    "Cache-Control": "no-store",
    ...cors,
  });
  res.end(frame);
}

// ---------------------------------------------------------------------------
// F9: webcam local
// ---------------------------------------------------------------------------

/** Una webcam integrada no se publica en la LAN: sólo la ve este equipo. */
function isLoopback(req: http.IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function serveWebcam(
  pathname: string,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  url: URL,
  cors: Record<string, string>,
) {
  if (!isLoopback(req)) {
    json(res, 403, { error: "La webcam sólo se sirve desde el propio equipo (usa la app o /stream/:id.mjpg)" }, cors);
    return;
  }

  const device = devicePathOf(url.searchParams.get("device") ?? "");
  if (!existsSync(device)) {
    json(res, 404, { error: `No hay ninguna webcam en ${device}`, device }, cors);
    return;
  }
  const capture = webcamCapture(device);

  if (pathname === "/webcam.jpg") {
    void sendWebcamSnapshot(res, capture, cors);
    return;
  }

  res.writeHead(200, {
    "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    ...cors,
  });

  const send = (frame: Buffer) => {
    if (res.writableEnded) return;
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write("\r\n");
  };

  const unsubscribe = capture.subscribe(send);
  const cleanup = () => {
    unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

async function sendWebcamSnapshot(
  res: http.ServerResponse,
  capture: ReturnType<typeof webcamCapture>,
  cors: Record<string, string>,
) {
  let frame = capture.snapshot();
  if (!frame) {
    // arranca la captura y espera al primer frame (como hace sendSnapshot)
    const unsubscribe = capture.subscribe(() => {});
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !(frame = capture.snapshot())) {
      await new Promise((r) => setTimeout(r, 200));
    }
    unsubscribe();
  }

  if (!frame) {
    const detail = capture.status();
    json(res, 503, { error: "Sin frame de la webcam", device: detail.device, detail }, cors);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": frame.length,
    "Cache-Control": "no-store",
    ...cors,
  });
  res.end(frame);
}
