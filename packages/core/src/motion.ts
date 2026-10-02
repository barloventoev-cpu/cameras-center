/**
 * F6 — detección de movimiento.
 *
 * FFmpeg calcula la puntuación de escena de cada frame con el filtro `select`
 * y la escribe por stderr como `lavfi.scene_score=0.123456`. Estas utilidades
 * interpretan esa línea y leen la configuración del entorno (compartida por
 * el agent y las pruebas).
 *
 * Umbral: con el O-KAM de esta red la escena en reposo ronda los 0.0001 y su
 * máximo ruidoso ha sido 0.0068 (416 muestras), así que 0.03 deja margen para
 * no disparar con el ruido y aun así coger a alguien que pase. Si la cámara
 * mira a la calle conviene subirlo; se afina con `GET :4100/api/motion`
 * (`maxScore`, `detections`).
 */

/** Extrae `lavfi.scene_score=…` de una línea de log de FFmpeg (o null). */
export function parseSceneScore(line: string): number | null {
  const match = /lavfi\.scene_score=([0-9]*\.?[0-9]+)/.exec(line);
  if (!match || !match[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export interface MotionSettings {
  /** Detección activada en el agent (`MOTION_ENABLED=false` la apaga). */
  enabled: boolean;
  /** Muestras por segundo que evalúa FFmpeg (`MOTION_FPS`). */
  sampleFps: number;
  /** Umbral de escena 0..1 (`MOTION_THRESHOLD`). */
  threshold: number;
  /** Enfriamiento entre avisos por cámara (`MOTION_COOLDOWN_MS`). */
  cooldownMs: number;
  /** Ancho (px) de la imagen del aviso (`MOTION_WIDTH`). */
  snapshotWidth: number;
}

function num(value: string | undefined, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function int(value: string | undefined, fallback: number, min = 1): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function motionSettings(env: Record<string, string | undefined> = process.env): MotionSettings {
  return {
    enabled: String(env.MOTION_ENABLED ?? "true").toLowerCase() !== "false",
    sampleFps: int(env.MOTION_FPS, 2, 1),
    threshold: num(env.MOTION_THRESHOLD, 0.03, 0, 1),
    cooldownMs: int(env.MOTION_COOLDOWN_MS, 30_000, 1000),
    snapshotWidth: int(env.MOTION_WIDTH, 640, 64),
  };
}
