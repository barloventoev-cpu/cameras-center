import { io, type Socket } from "socket.io-client";
import {
  CHANNELS,
  parseServerToAgentMessage,
  type AgentClipReady,
  type AgentDiscoverResult,
  type AgentDisk,
  type AgentEvent,
  type AgentHello,
  type ServerToAgentMessage,
} from "@cameras/protocol";
import { config } from "../config";

export interface ServerTransport {
  socket: Socket;
  emitStatus: (report: unknown) => void;
  /** F6: envía un evento (movimiento) al server. Devuelve false si no hay conexión. */
  emitEvent: (event: AgentEvent) => boolean;
  /** F7: envía la URL de un clip grabado y subido. */
  emitClipReady: (clip: AgentClipReady) => boolean;
  /** Uso de disco local (panel de almacenamiento). */
  emitDisk: (disk: AgentDisk) => void;
  /** F8: devuelve el resultado de una búsqueda de cámaras en la LAN. */
  emitDiscoverResult: (result: AgentDiscoverResult) => boolean;
}

export interface ServerTransportHandlers {
  /** El server pide empezar a reenviar una cámara (hay espectadores remotos). */
  onStartStream?: (cameraId: string, profile: string) => void;
  /** El server dice que paren (ya nadie la mira desde fuera). */
  onStopStream?: (cameraId: string, reason: string) => void;
  /** Al perder la conexión hay que soltar todo el relay. */
  onDisconnect?: () => void;
  /** F7: el server pide un clip (disparo manual desde la API/UI). */
  onRecordClip?: (cameraId: string, durationMs: number) => void;
  /** El server pide aplicar resolución/FPS a una cámara (panel del admin). */
  onSetEncoding?: (cameraId: string, width: number, fps: number) => void;
  /** F8: el server pide buscar cámaras en la red local (siempre hay respuesta). */
  onDiscover?: (requestId: string, options: unknown) => void;
}

/**
 * Conexión saliente (outbound) hacia el server.
 *
 * El agent nunca abre puertos: sólo sale hacia `SERVER_WSS_URL`.
 * El `auth.token` (AGENT_TOKEN) se valida en el handshake del server.
 */
export function connectToServer(
  getHello: () => Omit<AgentHello, "type">,
  handlers: ServerTransportHandlers = {},
): ServerTransport {
  const socket = io(config.serverUrl, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 15000,
    auth: config.agentTokenOut ? { token: config.agentTokenOut } : undefined,
  });

  socket.on("connect", () => {
    console.log(`[agent] conectado al server ${config.serverUrl}`);
    socket.emit(CHANNELS.agentHello, { type: "agent:hello", ...getHello() } satisfies AgentHello);
  });

  socket.on("connect_error", (error) => {
    console.warn(`[agent] error de conexión: ${error.message}`);
  });

  socket.on("disconnect", (reason) => {
    console.warn(`[agent] desconectado (${reason}). Reintentando...`);
    handlers.onDisconnect?.();
  });

  socket.on(CHANNELS.serverConfigSync, (raw) => {
    const message = raw as ServerToAgentMessage;
    if (message.type === "server:configSync") {
      console.log(`[agent] configSync recibido: ${message.cameras.length} camara(s)`);
    }
  });

  socket.on(CHANNELS.serverStartStream, (raw) => {
    const parsed = parseServerToAgentMessage(raw);
    if (parsed.type !== "server:startStream") return;
    console.log(`[agent] startStream ${parsed.cameraId} (${parsed.profile})`);
    handlers.onStartStream?.(parsed.cameraId, parsed.profile);
  });

  socket.on(CHANNELS.serverStopStream, (raw) => {
    const parsed = parseServerToAgentMessage(raw);
    if (parsed.type !== "server:stopStream") return;
    console.log(`[agent] stopStream ${parsed.cameraId} (${parsed.reason})`);
    handlers.onStopStream?.(parsed.cameraId, parsed.reason);
  });

  socket.on(CHANNELS.serverRecordClip, (raw) => {
    const parsed = parseServerToAgentMessage(raw);
    if (parsed.type !== "server:recordClip") return;
    console.log(`[agent] recordClip ${parsed.cameraId} (${parsed.durationMs} ms)`);
    handlers.onRecordClip?.(parsed.cameraId, parsed.durationMs);
  });

  socket.on(CHANNELS.serverSetEncoding, (raw) => {
    const parsed = parseServerToAgentMessage(raw);
    if (parsed.type !== "server:setEncoding") return;
    console.log(`[agent] setEncoding ${parsed.cameraId} (${parsed.width}px @ ${parsed.fps}fps)`);
    handlers.onSetEncoding?.(parsed.cameraId, parsed.width, parsed.fps);
  });

  // F8: el server pide una búsqueda de cámaras en la LAN. Se tolera un payload
  // raro: si el parsing falla se contesta igualmente con un error, para que la
  // petición HTTP del server no se quede esperando hasta el timeout.
  socket.on(CHANNELS.serverDiscover, (raw) => {
    try {
      const parsed = parseServerToAgentMessage(raw);
      if (parsed.type !== "server:discover") return;
      console.log(`[agent] discover pedido (${parsed.ip ?? parsed.subnet ?? "subred auto"})`);
      handlers.onDiscover?.(parsed.requestId, parsed);
    } catch (error) {
      const requestId = String((raw as { requestId?: unknown })?.requestId ?? "");
      if (!requestId) return;
      console.warn(`[agent] discover inválido: ${error instanceof Error ? error.message : String(error)}`);
      handlers.onDiscover?.(requestId, { invalid: true });
    }
  });

  return {
    socket,
    emitStatus: (report) => socket.emit(CHANNELS.agentStatus, { type: "agent:status", report }),
    emitEvent: (event) => {
      if (!socket.connected) return false;
      socket.emit(CHANNELS.agentEvent, event);
      return true;
    },
    emitClipReady: (clip) => {
      if (!socket.connected) return false;
      socket.emit(CHANNELS.agentClipReady, clip);
      return true;
    },
    emitDisk: (disk) => {
      socket.emit(CHANNELS.agentDisk, disk);
    },
    emitDiscoverResult: (result) => {
      if (!socket.connected) return false;
      socket.emit(CHANNELS.agentDiscoverResult, result);
      return true;
    },
  };
}
