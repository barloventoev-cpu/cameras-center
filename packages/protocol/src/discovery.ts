import { z } from "zod";

/**
 * F8 — descubrimiento automático de cámaras en la red local.
 *
 * La búsqueda la hace el **agent**, que es el único que está en la LAN (en
 * producción el server vive en Render y no ve la red privada). El server sólo
 * hace de relay:
 *
 *   web ──POST /api/v1/discover──► server ──server:discover──► agent
 *                                                        │  barrido TCP + HTTP
 *                                                        │  + RTSP + ONVIF
 *   web ◄──{ hosts }◄── agent:discoverResult ◄───────────┘
 *
 * Dos sondeos en paralelo:
 *  1. **TCP**: puertos típicos de cámaras en cada host de la subred; los que
 *     abren se sondean con HTTP (Server/Title) y con `DESCRIBE` RTSP.
 *  2. **ONVIF**: M-SEARCH WS-Discovery por UDP a 239.255.255.250:3702 y, por
 *     cada XAddr, GetDeviceInformation → GetCapabilities → GetProfiles →
 *     GetStreamUri (marca, modelo y URL RTSP).
 */

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

/** Opciones de una búsqueda (todas opcionales: por defecto la subred se deduce). */
export const DiscoverOptionsSchema = z.object({
  /** Subred en CIDR (`192.168.1.0/24`). Si se omite, el agent usa la suya. */
  subnet: z.string().max(64).regex(CIDR, "subred en formato x.x.x.0/24").optional(),
  /** IP concreta: sólo se sondea esa (búsqueda puntual, muy rápida). */
  ip: z.string().max(15).regex(IPV4, "IP IPv4 no válida").optional(),
  /** Puertos TCP a sondear. Si se omite: 80,443,554,8554,8080,8000,37777,8899,10554,34567. */
  ports: z.array(z.number().int().min(1).max(65535)).max(32).optional(),
  /** Timeout de cada conexión TCP (ms). */
  timeoutMs: z.number().int().min(200).max(3000).optional(),
  /** Enviar también el M-SEARCH ONVIF (WS-Discovery). */
  onvif: z.boolean().default(true),
});
export type DiscoverOptions = z.output<typeof DiscoverOptionsSchema>;
/** Lo que se recibe de la red: mismos campos, sin defaults aplicados. */
export type DiscoverOptionsInput = z.input<typeof DiscoverOptionsSchema>;

/** Servicio HTTP encontrado en un host (interfaz web de la cámara, NVR…). */
export const HttpInfoSchema = z.object({
  port: z.number().int(),
  server: z.string().default(""),
  title: z.string().default(""),
});
export type HttpInfo = z.infer<typeof HttpInfoSchema>;

/** Servidor RTSP vivo en el host (`DESCRIBE` contesta, aunque sea 401). */
export const RtspInfoSchema = z.object({
  port: z.number().int(),
  ok: z.boolean(),
  /** Ruta que respondió (`/tcp/av0_0`, `/live`, …). */
  uri: z.string().nullable().default(null),
  banner: z.string().default(""),
});
export type RtspInfo = z.infer<typeof RtspInfoSchema>;

/** Dispositivo ONVIF respondiendo al WS-Discovery. */
export const OnvifInfoSchema = z.object({
  xaddr: z.string(),
  manufacturer: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  firmware: z.string().nullable().default(null),
  /** URL RTSP que da GetStreamUri (null si pide credenciales). */
  rtsp: z.string().nullable().default(null),
  authRequired: z.boolean().default(false),
  error: z.string().nullable().default(null),
});
export type OnvifInfo = z.infer<typeof OnvifInfoSchema>;

/** Un host vivo de la red con todo lo que se pudo averiguar de él. */
export const DiscoveredHostSchema = z.object({
  ip: z.string(),
  /** Puertos TCP abiertos (ordenados). */
  open: z.array(z.number().int()).default([]),
  http: HttpInfoSchema.nullable().default(null),
  rtsp: RtspInfoSchema.nullable().default(null),
  onvif: OnvifInfoSchema.nullable().default(null),
  /**
   * URL RTSP candidata, lista para pegar en el formulario de alta.
   * Credenciales no incluidas: hay que añadir usuario y contraseña.
   */
  suggestion: z.string().nullable().default(null),
});
export type DiscoveredHost = z.infer<typeof DiscoveredHostSchema>;

/** Server → agent: «busca cámaras en tu red». */
export const ServerDiscoverSchema = DiscoverOptionsSchema.extend({
  type: z.literal("server:discover"),
  requestId: z.string().min(1).max(64),
});
export type ServerDiscover = z.infer<typeof ServerDiscoverSchema>;

/** Agent → server: resultado de la búsqueda (siempre responde, aunque falle). */
export const AgentDiscoverResultSchema = z.object({
  type: z.literal("agent:discoverResult"),
  /** Correlación con la petición (el server tiene varias en el aire). */
  requestId: z.string().min(1).max(64),
  ok: z.boolean(),
  agentId: z.string().optional(),
  /** Subred realmente barrida (para mostrarla en la UI). */
  subnet: z.string().default(""),
  /** Hosts sondeados (254 en un /24). */
  scanned: z.number().int().nonnegative().default(0),
  elapsedMs: z.number().int().nonnegative().default(0),
  hosts: z.array(DiscoveredHostSchema).default([]),
  /** Sólo si `ok=false` (p. ej. «ya hay una búsqueda en curso»). */
  error: z.string().optional(),
});
export type AgentDiscoverResult = z.infer<typeof AgentDiscoverResultSchema>;
