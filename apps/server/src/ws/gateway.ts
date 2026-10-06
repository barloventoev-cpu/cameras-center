import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server, type Socket } from "socket.io";
import {
  CHANNELS,
  safeParseAgentClipReady,
  safeParseAgentDiscoverResult,
  safeParseAgentEvent,
  safeParseFrameHeader,
  safeParseViewerMessage,
  type AgentDiscoverResult,
  type DiscoverOptions,
  type StreamProfile,
} from "@cameras/protocol";
import { isApiKeyLike } from "@cameras/core";
import { verifyToken } from "../auth/jwt";
import { verifyApiKey } from "../keys";
import { keyLimiter } from "../middleware/rateLimit";
import { config } from "../config";
import { captureThumb } from "../thumbs";
import { recordAgentClip, recordAgentEvent, toSummary } from "../events";
import { frameCache } from "./frames";

export interface StreamRequest {
  cameraId: string;
  profile: StreamProfile;
  viewers: string[];
}

/** Estado del WS para `GET /api/health` (F4/F5). */
export interface GatewayStats {
  connected: number;
  agents: number;
  viewers: number;
  /** Espectadores que llegan por el endpoint HTTP MJPEG (F5). */
  http: number;
  cameras: Array<{ cameraId: string; viewers: number }>;
}

/**
 * Resultado de una búsqueda de cámaras pedida al agent (F8).
 *  - `sin-agent`: no hay ningún agent conectado (la red la ve sólo él).
 *  - `timeout`: el agent no contestó en el plazo (búsqueda larga o caída).
 *  - `error`: el agent contestó pero no pudo completar la búsqueda.
 */
export type DiscoverOutcome =
  | { code: "ok"; result: AgentDiscoverResult }
  | { code: "sin-agent" }
  | { code: "timeout" }
  | { code: "error"; message: string };

export interface Gateway {
  io: Server;
  /** Nº de espectadores suscritos a una cámara. */
  viewerCount(cameraId: string): number;
  /** Se dispara cuando alguien empieza a mirar una cámara. */
  onStreamRequest(cb: (request: StreamRequest) => void): void;
  onStreamRelease(cb: (cameraId: string) => void): void;
  /** Difunda el estado de una cámara a todos los espectadores. */
  broadcastStatus(cameraId: string, status: string): void;
  /** Resumen de conexiones (agentes conectados, espectadores por cámara). */
  stats(): GatewayStats;
  /** F7: pide al agent que grabe un clip. false = no hay ningún agent. */
  requestClip(cameraId: string, durationMs?: number): boolean;
  /**
   * Pide al agent aplicar resolución/FPS a una cámara. false = sin agent.
   * Sin ACK: el agent lo confirma en su próximo reporte de estado.
   */
  requestEncoding(cameraId: string, width: number, fps: number): boolean;
  /** Última codificación reportada por el agent (para GET /encoding). */
  lastEncoding(cameraId: string): { width: number; fps: number } | undefined;
  /**
   * F8: pide al agent que busque cámaras en su red y espera su respuesta.
   * Devuelve `sin-agent` si no hay nadie escuchando y `timeout` si no contesta.
   */
  requestDiscover(options: DiscoverOptions, timeoutMs?: number): Promise<DiscoverOutcome>;
  /** Espectador HTTP (endpoint MJPEG): pide/apaga el stream del agent. */
  acquire(cameraId: string): void;
  release(cameraId: string): void;
}

const AGENT_ROOM = "agents";
const cameraRoom = (cameraId: string) => `cam:${cameraId}`;

/** Última codificación (resolución/FPS) reportada por el agent por cámara. */
const lastEncodings = new Map<string, { width: number; fps: number }>();

/** Último uso de disco reportado por el agent (panel de almacenamiento). */
export const agentDisk = {
  agentId: null as string | null,
  clipsBytes: 0,
  clips: 0,
  at: 0,
};

/** Frames enviados a un espectador que aún no ha confirmado (antimancha). */
const MAX_INFLIGHT = 4;
/** Si un espectador no confirma en este tiempo, se le vuelve a permitir. */
const INFLIGHT_STALE_MS = 5000;

/**
 * Gateway WebSocket — F3 (relay de video).
 *
 *   agent ──stream:frame──► server ──stream:frame──► viewers (sala cam:<id>)
 *
 * - El plano de **control** (subscribe/startStream) es JSON y se valida con Zod.
 * - El plano de **medios** binario NO se valida: sólo se comprueba el header.
 * - Autenticación en el handshake: `auth.token` = AGENT_TOKEN (agent) o JWT (viewer).
 * - Si no hay espectadores no se reenvía nada (el caché sólo guarda 1 JPEG).
 */
export function createGateway(httpServer: HttpServer): Gateway {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
    maxHttpBufferSize: 2e6, // un JPEG de 1280px anda por 60-150 KB
  });

  const streamRequestCbs: Array<(request: StreamRequest) => void> = [];
  const streamReleaseCbs: Array<(cameraId: string) => void> = [];

  /**
   * F8: peticiones de búsqueda en vuelo. El server manda `server:discover` con
   * un `requestId` y el agent responde con el mismo; aquí se correlacionan.
   */
  const pendingDiscover = new Map<string, { resolve: (outcome: DiscoverOutcome) => void; timer: ReturnType<typeof setTimeout> }>();

  const settleDiscover = (requestId: string, outcome: DiscoverOutcome): void => {
    const pending = pendingDiscover.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDiscover.delete(requestId);
    pending.resolve(outcome);
  };

  /**
   * Espectadores que NO vienen por socket.io: el endpoint HTTP MJPEG
   * `GET /api/v1/streams/:id.mjpg` cuenta también (F5), para que el agent
   * arranque aunque el tercero no abra WebSocket.
   */
  const httpViewers = new Map<string, number>();

  const roomSize = (cameraId: string) => io.sockets.adapter.rooms.get(cameraRoom(cameraId))?.size ?? 0;
  const viewerCount = (cameraId: string) => roomSize(cameraId) + (httpViewers.get(cameraId) ?? 0);

  const requestStream = (cameraId: string, profile: StreamProfile = "remote") => {
    const viewers = [...(io.sockets.adapter.rooms.get(cameraRoom(cameraId)) ?? [])];
    // puede que el único espectador sea el endpoint MJPEG (sin sockets)
    if (viewers.length === 0 && (httpViewers.get(cameraId) ?? 0) === 0) return;
    io.to(AGENT_ROOM).emit(CHANNELS.serverStartStream, {
      type: "server:startStream",
      cameraId,
      profile,
      viewers,
    });
    for (const cb of streamRequestCbs) cb({ cameraId, profile, viewers });
  };

  const releaseStream = (cameraId: string, reason: "no-viewers" | "disabled" | "shutdown" = "no-viewers") => {
    io.to(AGENT_ROOM).emit(CHANNELS.serverStopStream, { type: "server:stopStream", cameraId, reason });
    for (const cb of streamReleaseCbs) cb(cameraId);
  };

  /** Un cliente HTTP entra a mirar (pide el stream si era el primero). */
  const acquire = (cameraId: string): void => {
    const wasEmpty = viewerCount(cameraId) === 0;
    httpViewers.set(cameraId, (httpViewers.get(cameraId) ?? 0) + 1);
    if (wasEmpty) requestStream(cameraId, "remote");
  };

  /** Un cliente HTTP se va; al llegar a 0 se apaga el agent. */
  const release = (cameraId: string): void => {
    const next = (httpViewers.get(cameraId) ?? 0) - 1;
    if (next > 0) httpViewers.set(cameraId, next);
    else httpViewers.delete(cameraId);
    if (viewerCount(cameraId) === 0) releaseStream(cameraId);
  };

  /** Repetir el pedido a un agent que (re)conecta: si hay espectadores, que arranque. */
  const rearmStreams = () => {
    for (const [room, sockets] of io.sockets.adapter.rooms) {
      if (!room.startsWith("cam:") || sockets.size === 0) continue;
      requestStream(room.slice("cam:".length));
    }
  };

  // --- Autenticación en el handshake ---------------------------------------
  io.use(async (socket, next) => {
    const token = String(socket.handshake.auth?.token ?? "");
    if (config.agentToken && token === config.agentToken) {
      socket.data.role = "agent";
      return next();
    }
    if (!config.agentToken && !token) {
      socket.data.role = "agent"; // sólo desarrollo sin AGENT_TOKEN
      return next();
    }

    // F5: una tercero puede ver el stream con API key (scope `stream`)
    if (isApiKeyLike(token)) {
      try {
        const key = await verifyApiKey(token);
        if (!key) return next(new Error("api-key-invalida"));
        if (!key.scopes.includes("stream")) return next(new Error("scope-stream"));
        socket.data.role = "viewer";
        socket.data.principal = { type: "apikey", id: key.id, rpm: key.rpm };
        return next();
      } catch {
        return next(new Error("api-key-invalida"));
      }
    }

    try {
      const payload = await verifyToken(token);
      socket.data.role = "viewer";
      socket.data.userId = payload.sub;
      socket.data.principal = { type: "jwt", id: payload.sub };
      return next();
    } catch {
      return next(new Error("no-autorizado"));
    }
  });

  io.on("connection", (socket) => {
    // --- Agentes ------------------------------------------------------------
    socket.on(CHANNELS.agentHello, (payload) => {
      socket.join(AGENT_ROOM);
      socket.data.agentId = payload?.agentId ?? "unknown";
      socket.data.role = "agent";
      io.emit(CHANNELS.agentHello, payload);
      // Si alguien ya está mirando cuando (re)conecta el agent, pedirle el stream
      rearmStreams();
    });

    socket.on(CHANNELS.agentStatus, (payload) => {
      socket.to(AGENT_ROOM).emit(CHANNELS.agentStatus, payload);
      if (payload?.report?.cameraId) {
        io.to(cameraRoom(payload.report.cameraId)).emit(CHANNELS.agentStatus, payload);
        const enc = payload.report.encoding;
        if (enc && Number.isFinite(enc.width) && Number.isFinite(enc.fps)) {
          lastEncodings.set(payload.report.cameraId, { width: enc.width, fps: enc.fps });
        }
      }
    });

    socket.on(CHANNELS.agentDisk, (payload) => {
      if (socket.data.role !== "agent") return;
      const d = (payload ?? {}) as { agentId?: unknown; clipsBytes?: unknown; clips?: unknown; at?: unknown };
      if (typeof d.clipsBytes !== "number" || typeof d.clips !== "number") return;
      agentDisk.agentId = typeof d.agentId === "string" ? d.agentId : (socket.data.agentId ?? null);
      agentDisk.clipsBytes = Math.max(0, Math.floor(d.clipsBytes));
      agentDisk.clips = Math.max(0, Math.floor(d.clips));
      agentDisk.at = typeof d.at === "number" ? d.at : Date.now();
    });

    // --- F8: el agent devuelve el resultado de una búsqueda ------------------
    socket.on(CHANNELS.agentDiscoverResult, (raw: unknown) => {
      if (socket.data.role !== "agent") return;
      const parsed = safeParseAgentDiscoverResult(raw);
      if (!parsed.success) {
        console.warn(`[gateway] agent:discoverResult inválido: ${parsed.error.issues[0]?.message ?? ""}`);
        return;
      }
      const result = parsed.data;
      settleDiscover(
        result.requestId,
        result.ok
          ? { code: "ok", result }
          : { code: "error", message: result.error ?? "El agent no pudo completar la búsqueda" },
      );
    });

    // --- F6: el agent avisa de un evento (movimiento) ------------------------
    socket.on(CHANNELS.agentEvent, (raw: unknown) => {
      if (socket.data.role !== "agent") return;
      const parsed = safeParseAgentEvent(raw);
      if (!parsed.success) {
        console.warn(`[gateway] agent:event inválido: ${parsed.error.issues[0]?.message ?? ""}`);
        return;
      }
      // subir a Cloudinary + guardar + webhooks: sin bloquear el socket
      void recordAgentEvent(parsed.data)
        .then((stored) => {
          if (stored) io.emit(CHANNELS.eventNew, { type: "event:new", event: toSummary(stored) });
        })
        .catch((error) => console.warn(`[gateway] error registrando evento: ${error instanceof Error ? error.message : error}`));
    });

    // --- F7: el agent avisa de un clip grabado y subido -----------------------
    socket.on(CHANNELS.agentClipReady, (raw: unknown) => {
      if (socket.data.role !== "agent") return;
      const parsed = safeParseAgentClipReady(raw);
      if (!parsed.success) {
        console.warn(`[gateway] agent:clipReady inválido: ${parsed.error.issues[0]?.message ?? ""}`);
        return;
      }
      void recordAgentClip(parsed.data)
        .then((stored) => {
          if (stored) io.emit(CHANNELS.eventNew, { type: "event:new", event: toSummary(stored) });
        })
        .catch((error) => console.warn(`[gateway] error registrando clip: ${error instanceof Error ? error.message : error}`));
    });

    // --- Plano de medios: agent -> server -> viewers ------------------------
    socket.on(CHANNELS.streamFrame, (rawHeader: unknown, rawPayload: unknown) => {
      if (socket.data.role !== "agent") return;

      const header = safeParseFrameHeader(rawHeader);
      if (!header.success) return;

      const data = toBuffer(rawPayload);
      if (!data || data.length === 0) return;

      const { cameraId } = header.data;
      frameCache.set(cameraId, header.data, data);
      // F4: de paso, sube un thumbnail a Cloudinary (rate-limited y sin-op
      // en la práctica: sólo trabaja cada THUMB_INTERVAL_MS).
      void captureThumb(cameraId);

      const room = io.sockets.adapter.rooms.get(cameraRoom(cameraId));
      if (!room || room.size === 0) return; // sin espectadores: no reenviar

      const now = Date.now();
      for (const viewerId of room) {
        const viewer = io.sockets.sockets.get(viewerId);
        if (!viewer) continue;

        // Control de backpressure: si el espectador va lento, saltamos frames
        // en vez de encolarlos (una cámara a 6 fps recupera sin problemas).
        const pending = Number(viewer.data.pendingFrames ?? 0);
        const lastAck = Number(viewer.data.lastFrameAck ?? 0);
        if (pending >= MAX_INFLIGHT) {
          if (now - lastAck < INFLIGHT_STALE_MS) continue;
          viewer.data.pendingFrames = 0; // cliente atascado: liberar
        }
        viewer.data.pendingFrames = Number(viewer.data.pendingFrames ?? 0) + 1;
        viewer.data.lastFrameAck = now;
        viewer.emit(CHANNELS.streamFrame, header.data, data, () => {
          viewer.data.pendingFrames = Math.max(0, Number(viewer.data.pendingFrames ?? 1) - 1);
          viewer.data.lastFrameAck = Date.now();
        });
      }
    });

    // --- Viewers ------------------------------------------------------------
    socket.on(
      CHANNELS.viewerSubscribe,
      (raw, ack?: (r: { ok: boolean; error?: string; retryAfterSec?: number }) => void) => {
        if (socket.data.role !== "viewer") return ack?.({ ok: false });
        const parsed = safeParseViewerMessage({ ...(raw as object), type: "viewer:subscribe" });
        if (!parsed.success) return ack?.({ ok: false });

        // F5: una API key también consume cuota al suscribirse al stream
        const principal = socket.data.principal as { type?: string; id?: string; rpm?: number } | undefined;
        if (principal?.type === "apikey") {
          const rpm = principal.rpm && principal.rpm > 0 ? principal.rpm : 60;
          const verdict = keyLimiter.take(`key:${principal.id}`, rpm);
          if (!verdict.allowed) {
            return ack?.({ ok: false, error: "Límite de peticiones excedido", retryAfterSec: verdict.resetSec });
          }
        }

        const { cameraId } = parsed.data;
        const wasEmpty = viewerCount(cameraId) === 0;
        socket.join(cameraRoom(cameraId));
        socket.data.subscriptions = [...new Set([...(socket.data.subscriptions ?? []), cameraId])];

        if (wasEmpty) requestStream(cameraId, "remote");
        // devolver el último frame cacheado para que no haya pantalla negra.
        // seq=-1 marca que es una imagen de "puesta al día" y no un frame en vivo.
        const cached = frameCache.get(cameraId);
        if (cached) socket.emit(CHANNELS.streamFrame, { ...cached.header, seq: -1 }, cached.data);
        ack?.({ ok: true });
      },
    );

    socket.on(CHANNELS.viewerUnsubscribe, (raw, ack?: (r: { ok: boolean }) => void) => {
      const parsed = safeParseViewerMessage({ ...(raw as object), type: "viewer:unsubscribe" });
      if (!parsed.success) return ack?.({ ok: false });

      const { cameraId } = parsed.data;
      socket.leave(cameraRoom(cameraId));
      socket.data.subscriptions = (socket.data.subscriptions ?? []).filter((id: string) => id !== cameraId);
      if (viewerCount(cameraId) === 0) releaseStream(cameraId);
      ack?.({ ok: true });
    });

    // F8: si se cae el único agent con una búsqueda en vuelo, contestar ya:
    // si no, la petición HTTP del navegador esperaría al timeout completo.
    socket.on("disconnecting", () => {
      if (socket.data.role !== "agent") return;
      const others = [...(io.sockets.adapter.rooms.get(AGENT_ROOM) ?? [])].filter((id) => id !== socket.id);
      if (others.length > 0) return;
      for (const requestId of [...pendingDiscover.keys()]) settleDiscover(requestId, { code: "sin-agent" });
    });

    socket.on("disconnect", () => {
      for (const cameraId of socket.data.subscriptions ?? []) {
        if (viewerCount(cameraId) === 0) releaseStream(cameraId);
      }
      socket.data.subscriptions = [];
    });
  });

  return {
    io,
    viewerCount,
    acquire,
    release,
    onStreamRequest: (cb) => streamRequestCbs.push(cb),
    onStreamRelease: (cb) => streamReleaseCbs.push(cb),
    // F7: si no hay agent conectado no se puede grabar (la ruta lo traduce a 409)
    requestClip: (cameraId, durationMs) => {
      if ((io.sockets.adapter.rooms.get(AGENT_ROOM)?.size ?? 0) === 0) return false;
      io.to(AGENT_ROOM).emit(CHANNELS.serverRecordClip, {
        type: "server:recordClip",
        cameraId,
        ...(durationMs ? { durationMs } : {}),
      });
      return true;
    },
    requestEncoding: (cameraId, width, fps) => {
      if ((io.sockets.adapter.rooms.get(AGENT_ROOM)?.size ?? 0) === 0) return false;
      io.to(AGENT_ROOM).emit(CHANNELS.serverSetEncoding, {
        type: "server:setEncoding",
        cameraId,
        width,
        fps,
      });
      return true;
    },
    lastEncoding: (cameraId) => lastEncodings.get(cameraId),
    // F8: búsqueda de cámaras en la LAN. Se espera la respuesta del agent
    // (barrido + ONVIF, ~5-30 s); sin agent ni timeout se contesta en seguida.
    requestDiscover: (options, timeoutMs = 60_000) => {
      if ((io.sockets.adapter.rooms.get(AGENT_ROOM)?.size ?? 0) === 0) return Promise.resolve({ code: "sin-agent" });
      const requestId = randomUUID();
      return new Promise<DiscoverOutcome>((resolve) => {
        const timer = setTimeout(() => {
          pendingDiscover.delete(requestId);
          resolve({ code: "timeout" });
        }, timeoutMs);
        pendingDiscover.set(requestId, { resolve, timer });
        io.to(AGENT_ROOM).emit(CHANNELS.serverDiscover, { type: "server:discover", requestId, ...options });
      });
    },
    broadcastStatus: (cameraId, status) => {
      io.to(cameraRoom(cameraId)).emit(CHANNELS.agentStatus, { report: { cameraId, status } });
    },
    stats: () => {
      let agents = 0;
      let viewers = 0;
      const cameras: Array<{ cameraId: string; viewers: number }> = [];
      for (const [room, sockets] of io.sockets.adapter.rooms) {
        if (room === AGENT_ROOM) agents = sockets.size;
        else if (room.startsWith("cam:") && sockets.size > 0) {
          cameras.push({ cameraId: room.slice("cam:".length), viewers: sockets.size });
          viewers += sockets.size;
        }
      }
      // sumar los espectadores HTTP (endpoint MJPEG) que no viven en rooms
      let http = 0;
      for (const count of httpViewers.values()) http += count;
      for (const [cameraId, count] of httpViewers) {
        const existing = cameras.find((c) => c.cameraId === cameraId);
        if (existing) existing.viewers += count;
        else cameras.push({ cameraId, viewers: count });
      }
      return { connected: io.sockets.sockets.size, agents, viewers: viewers + http, http, cameras };
    },
  };
}

function toBuffer(payload: unknown): Buffer | null {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (Array.isArray(payload)) return Buffer.from(payload);
  return null;
}
