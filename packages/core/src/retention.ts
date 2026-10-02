/**
 * Retención de eventos y assets (ahorro de espacio).
 *
 * - `RETENTION_ENABLED=false` apaga la purga (se conserva todo).
 * - `RETENTION_DAYS_EVENTS`: filas de `events` (motion/clip) más viejas se
 *   borran de Supabase (las miniaturas F4, una por cámara, nunca se tocan).
 * - `RETENTION_DAYS_ASSETS`: fotos y MP4 de esos eventos se borran de
 *   Cloudinary con la misma edad (por defecto igual que los eventos).
 *
 * La purga corre en el server una vez al día + bajo demanda
 * (`POST /api/v1/storage/purge`). Igual que F6/F7, la configuración vive aquí
 * para poder pasarle un `env` distinto en las pruebas.
 */

export interface RetentionSettings {
  /** `RETENTION_ENABLED=false` desactiva la purga. */
  enabled: boolean;
  /** Días de historial de eventos (motion/clip) en Supabase (`RETENTION_DAYS_EVENTS`). */
  daysEvents: number;
  /** Días de fotos/MP4 en Cloudinary (`RETENTION_DAYS_ASSETS`). */
  daysAssets: number;
}

function int(value: string | undefined, fallback: number, min: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function retentionSettings(env: Record<string, string | undefined> = process.env): RetentionSettings {
  return {
    enabled: String(env.RETENTION_ENABLED ?? "true").toLowerCase() !== "false",
    daysEvents: int(env.RETENTION_DAYS_EVENTS, 15, 1),
    daysAssets: int(env.RETENTION_DAYS_ASSETS, 15, 1),
  };
}
