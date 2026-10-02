import { z } from "zod";
import { CameraSchema, CameraStatusReportSchema, StreamProfileSchema } from "./camera";

/**
 * Protocolo de control (JSON) entre agent <-> server <-> viewer.
 *
 * El plano de MEDIOS (frames de video) NO pasa por aquí: viaja en eventos binarios
 * separados (`stream:frame`) con un header mínimo, para no validar con Zod cada
 * frame que pesa cientos de KB.
 */

// ---------------------------------------------------------------------------
// AGENT -> SERVER
// ---------------------------------------------------------------------------

export const AgentHelloSchema = z.object({
  type: z.literal("agent:hello"),
  agentId: z.string().min(1),
  version: z.string().min(1),
  cameras: z.array(CameraSchema),
  capabilities: z
    .array(z.enum(["rtsp", "onvif", "mjpeg", "record", "test", "motion"]))
    .default([]),
});
export type AgentHello = z.infer<typeof AgentHelloSchema>;

export const AgentStatusSchema = z.object({
  type: z.literal("agent:status"),
  report: CameraStatusReportSchema,
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentThumbSchema = z.object({
  type: z.literal("agent:thumb"),
  cameraId: z.string(),
  /** JPEG en base64. El server lo sube a Cloudinary y guarda la URL. */
  jpegBase64: z.string().min(1),
  ts: z.number(),
});
export type AgentThumb = z.infer<typeof AgentThumbSchema>;

export const AgentErrorSchema = z.object({
  type: z.literal("agent:error"),
  cameraId: z.string().optional(),
  message: z.string(),
});
export type AgentError = z.infer<typeof AgentErrorSchema>;

/**
 * F6: evento detectado por el agent (movimiento de escena).
 * `jpegBase64` es la imagen del momento: el server la sube a Cloudinary y
 * guarda la URL en `events`.
 */
export const AgentEventSchema = z.object({
  type: z.literal("agent:event"),
  cameraId: z.string().min(1),
  event: z.enum(["motion"]).default("motion"),
  /** Puntuación de escena FFmpeg (0..1) que superó el umbral. */
  score: z.number().min(0).max(1),
  /** Época (ms) en que se detectó. */
  at: z.number().int(),
  /** JPEG del instante del aviso, en base64 (opcional). */
  jpegBase64: z.string().optional(),
  agentId: z.string().optional(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/**
 * F7: el agent terminó de grabar un clip y ya está subido.
 * Viaja **sólo la URL** (el WebSocket limita los mensajes a 2 MB: un MP4 no
 * cabe, y el archivo ya vive en disco y en Cloudinary).
 */
export const AgentClipReadySchema = z.object({
  type: z.literal("agent:clipReady"),
  cameraId: z.string().min(1),
  /** URL pública del MP4 en Cloudinary. */
  url: z.string().min(1),
  /** Duración real grabada (ms). */
  durationMs: z.number().int().nonnegative(),
  /** Tamaño del archivo MP4 (bytes). */
  bytes: z.number().int().nonnegative(),
  /** Época (ms) en que empezó la grabación. */
  at: z.number().int(),
  /** Aviso de movimiento o petición manual desde la API/UI. */
  trigger: z.enum(["motion", "manual"]).default("motion"),
  agentId: z.string().optional(),
});
export type AgentClipReady = z.infer<typeof AgentClipReadySchema>;

export const AgentMessageSchema = z.discriminatedUnion("type", [
  AgentHelloSchema,
  AgentStatusSchema,
  AgentThumbSchema,
  AgentErrorSchema,
  AgentEventSchema,
  AgentClipReadySchema,
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// ---------------------------------------------------------------------------
// SERVER -> AGENT
// ---------------------------------------------------------------------------

export const StartStreamSchema = z.object({
  type: z.literal("server:startStream"),
  cameraId: z.string(),
  /** `local` = sin recodificar si es posible; `remote` = 720p/1.5Mbps para Render */
  profile: StreamProfileSchema.default("remote"),
  /** Ids de los espectadores interesados (para referencias / debugging). */
  viewers: z.array(z.string()).default([]),
});
export type StartStream = z.infer<typeof StartStreamSchema>;

export const StopStreamSchema = z.object({
  type: z.literal("server:stopStream"),
  cameraId: z.string(),
  reason: z.enum(["no-viewers", "disabled", "shutdown"]).default("no-viewers"),
});
export type StopStream = z.infer<typeof StopStreamSchema>;

export const ConfigSyncSchema = z.object({
  type: z.literal("server:configSync"),
  cameras: z.array(CameraSchema),
});
export type ConfigSync = z.infer<typeof ConfigSyncSchema>;

/**
 * F7: el server pide al agent que grabe un clip (disparo manual desde la
 * API/UI). El agent lo limita con su `CLIP_DURATION_MS` y contesta con
 * `agent:clipReady` cuando el MP4 está subido.
 */
export const RecordClipSchema = z.object({
  type: z.literal("server:recordClip"),
  cameraId: z.string(),
  /** Duración pedida (ms); el agent la recorta a `CLIP_MAX_MS`. */
  durationMs: z.number().int().positive().default(15000),
});
export type RecordClip = z.infer<typeof RecordClipSchema>;

/**
 * Codificación por cámara (resolución/FPS elegidos por el administrador).
 * Ancho = tope en px (el alto se ajusta al aspecto); fps con tope de 2.
 */
export const EncodingSchema = z.object({
  width: z.number().int().min(160).max(640).refine((n) => n % 2 === 0, {
    message: "ancho par entre 160 y 640",
  }),
  fps: z.union([z.literal(0.5), z.literal(1), z.literal(1.5), z.literal(2)]),
});
export type CameraEncoding = z.infer<typeof EncodingSchema>;

/** El server pide al agent aplicar una codificación (reinicia el FFmpeg). */
export const SetEncodingSchema = EncodingSchema.extend({
  type: z.literal("server:setEncoding"),
  cameraId: z.string(),
});
export type SetEncoding = z.infer<typeof SetEncodingSchema>;

export const ServerToAgentMessageSchema = z.discriminatedUnion("type", [
  StartStreamSchema,
  StopStreamSchema,
  ConfigSyncSchema,
  RecordClipSchema,
  SetEncodingSchema,
]);
export type ServerToAgentMessage = z.infer<typeof ServerToAgentMessageSchema>;

// ---------------------------------------------------------------------------
// VIEWER <-> SERVER
// ---------------------------------------------------------------------------

export const ViewerSubscribeSchema = z.object({
  type: z.literal("viewer:subscribe"),
  cameraId: z.string(),
});
export type ViewerSubscribe = z.infer<typeof ViewerSubscribeSchema>;

export const ViewerUnsubscribeSchema = z.object({
  type: z.literal("viewer:unsubscribe"),
  cameraId: z.string(),
});
export type ViewerUnsubscribe = z.infer<typeof ViewerUnsubscribeSchema>;

export const ViewerMessageSchema = z.discriminatedUnion("type", [
  ViewerSubscribeSchema,
  ViewerUnsubscribeSchema,
]);
export type ViewerMessage = z.infer<typeof ViewerMessageSchema>;

export const StreamMetaSchema = z.object({
  type: z.literal("stream:meta"),
  cameraId: z.string(),
  encoding: z.enum(["mjpeg", "fmp4"]),
  width: z.number().int(),
  height: z.number().int(),
  fps: z.number(),
  contentType: z.string(),
});
export type StreamMeta = z.infer<typeof StreamMetaSchema>;

// ---------------------------------------------------------------------------
// F6: eventos (movimiento) server -> web
// ---------------------------------------------------------------------------

export const EventSummarySchema = z.object({
  id: z.string(),
  cameraId: z.string(),
  cameraName: z.string().nullable().default(null),
  type: z.string().default("motion"),
  score: z.number().nullable().default(null),
  at: z.number(),
  createdAt: z.string(),
  snapshot: z.string().nullable().default(null),
  /** F7: URL del clip MP4 asociado (null si aún no lo hay). */
  clip: z.string().nullable().default(null),
});
export type EventSummary = z.infer<typeof EventSummarySchema>;

export const EventNewSchema = z.object({
  type: z.literal("event:new"),
  event: EventSummarySchema,
});
export type EventNew = z.infer<typeof EventNewSchema>;

// ---------------------------------------------------------------------------
// CANALES DE EVENTOS (nombres compartidos)
// ---------------------------------------------------------------------------

export const CHANNELS = {
  agentHello: "agent:hello",
  agentStatus: "agent:status",
  agentThumb: "agent:thumb",
  /** F6: aviso de evento (movimiento) con la imagen en base64. */
  agentEvent: "agent:event",
  /** F7: clip grabado y subido; sólo viaja la URL. */
  agentClipReady: "agent:clipReady",
  /** F7: el server pide al agent que grabe un clip. */
  serverRecordClip: "server:recordClip",
  /** F6: el server avisa a la web de un evento nuevo. */
  eventNew: "event:new",
  serverStartStream: "server:startStream",
  serverStopStream: "server:stopStream",
  serverConfigSync: "server:configSync",
  /** El server pide al agent aplicar resolución/FPS a una cámara. */
  serverSetEncoding: "server:setEncoding",
  viewerSubscribe: "viewer:subscribe",
  viewerUnsubscribe: "viewer:unsubscribe",
  streamMeta: "stream:meta",
  /** Evento binario: header JSON + payload de video. */
  streamFrame: "stream:frame",
} as const;

/** Header que viaja junto a cada frame binario. */
export const FrameHeaderSchema = z.object({
  cameraId: z.string(),
  seq: z.number().int(),
  ts: z.number(),
  encoding: z.enum(["mjpeg", "fmp4"]),
  /** true si este chunk cierra un frame completo (MJPEG: fin de imagen). */
  keyframe: z.boolean().default(false),
});
export type FrameHeader = z.infer<typeof FrameHeaderSchema>;

// ---------------------------------------------------------------------------
// Helpers de parsing
// ---------------------------------------------------------------------------

export function parseAgentMessage(raw: unknown): AgentMessage {
  return AgentMessageSchema.parse(raw);
}

export function safeParseAgentMessage(raw: unknown) {
  return AgentMessageSchema.safeParse(raw);
}

export function parseServerToAgentMessage(raw: unknown): ServerToAgentMessage {
  return ServerToAgentMessageSchema.parse(raw);
}

export function parseViewerMessage(raw: unknown): ViewerMessage {
  return ViewerMessageSchema.parse(raw);
}

export function safeParseViewerMessage(raw: unknown) {
  return ViewerMessageSchema.safeParse(raw);
}

export function parseStreamMeta(raw: unknown): StreamMeta {
  return StreamMetaSchema.parse(raw);
}

export function parseAgentEvent(raw: unknown): AgentEvent {
  return AgentEventSchema.parse(raw);
}

export function safeParseAgentEvent(raw: unknown) {
  return AgentEventSchema.safeParse(raw);
}

export function parseAgentClipReady(raw: unknown): AgentClipReady {
  return AgentClipReadySchema.parse(raw);
}

export function safeParseAgentClipReady(raw: unknown) {
  return AgentClipReadySchema.safeParse(raw);
}

export function parseRecordClip(raw: unknown): RecordClip {
  return RecordClipSchema.parse(raw);
}

// Los frames van por el plano binario: este header viaja como primer argumento
// del evento `stream:frame` y el JPEG como segundo (adjunto binario de socket.io).
export function parseFrameHeader(raw: unknown): FrameHeader {
  return FrameHeaderSchema.parse(raw);
}

export function safeParseFrameHeader(raw: unknown) {
  return FrameHeaderSchema.safeParse(raw);
}
