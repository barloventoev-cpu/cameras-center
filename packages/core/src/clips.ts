/**
 * F7 — grabación local de clips por eventos.
 *
 * Al detectar movimiento (F6) el agent abre una sesión RTSP propia, graba
 * `CLIP_DURATION_MS` de vídeo en un MP4 fragmentado, lo guarda en disco local
 * (`dataDir/clips/<cámara>/<ms>.mp4`) y lo sube a Cloudinary. Sólo la URL viaja
 * por el WebSocket: el socket limita los mensajes a 2 MB.
 *
 * El arranque de la grabación es *posterior* al instante del aviso: la foto del
 * evento (F6) cubre el momento exacto y el clip muestra lo que ocurre después.
 * Un pre-roll exigiría un búfer continuo (mejora futura).
 *
 * Igual que en F6, la configuración vive aquí para poder pasarle un `env`
 * distinto en las pruebas.
 */

export interface ClipSettings {
  /** `CLIP_ENABLED=false` desactiva la grabación automática por movimiento. */
  enabled: boolean;
  /** Duración de cada clip en ms (`CLIP_DURATION_MS`). */
  durationMs: number;
  /** Tope admitido para una petición manual (`CLIP_MAX_MS`). */
  maxMs: number;
  /** Clips conservados por cámara en disco local (`CLIP_KEEP`). */
  keep: number;
}

function int(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function clipSettings(env: Record<string, string | undefined> = process.env): ClipSettings {
  return {
    enabled: String(env.CLIP_ENABLED ?? "true").toLowerCase() !== "false",
    durationMs: int(env.CLIP_DURATION_MS, 15_000, 1000),
    maxMs: int(env.CLIP_MAX_MS, 60_000, 1000),
    keep: int(env.CLIP_KEEP, 20, 1),
  };
}
