import type { CameraSourceType } from "@cameras/protocol";

export interface SourceSpec {
  cameraId: string;
  sourceType: CameraSourceType;
  /** URL de conexión (rtsp/mjpeg) o identificador de fuente sintética. */
  connection: string;
  /** Tope de ancho en px (elegido por el admin; el alto sigue al aspecto). */
  width?: number;
  /** Fotogramas por segundo (tope 2; lo fija el admin). */
  fps?: number;
}

/** Codificación por defecto: 640 px de ancho y 2 fps como máximo. */
export const DEFAULT_ENCODING = { width: 640, fps: 2 } as const;

/** Sanea un encoding parcial (del store local o del server): recorta a rango. */
export function sanitizeEncoding(input: { width?: unknown; fps?: unknown }): {
  width: number;
  fps: number;
} {
  const w = typeof input.width === "number" && Number.isFinite(input.width) ? Math.round(input.width) : DEFAULT_ENCODING.width;
  const f = typeof input.fps === "number" && Number.isFinite(input.fps) ? input.fps : DEFAULT_ENCODING.fps;
  const width = Math.min(640, Math.max(160, w % 2 === 0 ? w : w - 1));
  const fps = [0.5, 1, 1.5, 2].includes(f) ? (f as 0.5 | 1 | 1.5 | 2) : DEFAULT_ENCODING.fps;
  return { width, fps };
}

/** Salida común: JPEG secuencial por stdout, listo para `multipart/x-mixed-replace`.
 *  El tope de ancho y los fps los fija el administrador por cámara (ver
 *  EncodingStore): menos píxeles y menos fps = menos ancho de banda del
 *  server en Render y de los clientes. */
export function buildOutputArgs(spec: SourceSpec): string[] {
  const { width, fps } = sanitizeEncoding({ width: spec.width, fps: spec.fps });
  return [
    "-an",
    "-vf",
    `fps=${fps},scale='min(${width},iw)':-2`,
    "-q:v",
    "6",
    "-f",
    "mjpeg",
    "pipe:1",
  ];
}

/**
 * Construye la línea de comandos de FFmpeg para una cámara.
 *
 * Nota de rendimiento (mejora pendiente): si la entrada ya es H.264 y sólo hay
 * que reenviarla, usar `-c:v copy` con salida `mpegts`/`fmp4` en vez de recodificar.
 * MJPEG siempre requiere recodificar.
 */
export function buildFfmpegArgs(spec: SourceSpec): string[] {
  const input = buildInputArgs(spec);
  return [...input, ...buildOutputArgs(spec)];
}

/**
 * Argumentos de entrada reutilizados por la detección de movimiento (F6):
 * ahí hace falta `loglevel info` para que FFmpeg imprima `lavfi.scene_score`.
 */
export function buildInputArgs(spec: SourceSpec, options: { loglevel?: string } = {}): string[] {
  const loglevel = options.loglevel ?? "warning";
  switch (spec.sourceType) {
    case "rtsp":
      // TCP evita el packet loss típico del UDP en wifi
      return ["-hide_banner", "-loglevel", loglevel, "-rtsp_transport", "tcp", "-i", spec.connection];

    case "mjpeg":
      // Cámara que expone un MJPEG por HTTP; se recodifica para normalizar fps/tamaño
      return ["-hide_banner", "-loglevel", loglevel, "-i", spec.connection];

    case "test":
      // Fuente sintética: patrón de prueba con contador. Sólo para desarrollo.
      // `-re` (input) limita la generación a tiempo real para no quemar CPU.
      return ["-hide_banner", "-loglevel", loglevel, "-re", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=6"];

    case "onvif":
    default:
      // ONVIF resuelve a una URL RTSP; si llega aquí, `connection` ya es esa URL
      return ["-hide_banner", "-loglevel", loglevel, "-rtsp_transport", "tcp", "-i", spec.connection];
  }
}
