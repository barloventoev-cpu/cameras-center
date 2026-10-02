import {
  deleteAsset,
  parseCloudinaryUrl,
  retentionSettings,
} from "@cameras/core";
import { deleteEventsByIds, listEventsForPurge } from "./events";

/**
 * Retención de eventos y assets (ahorro de espacio).
 *
 * - Filas `events` (motion/clip) más viejas que `RETENTION_DAYS_EVENTS` se
 *   borran de Supabase (las miniaturas F4, una por cámara, nunca se tocan).
 * - Fotos y MP4 de eventos más viejos que `RETENTION_DAYS_ASSETS` se borran
 *   de Cloudinary (sólo URLs propias: `res.cloudinary.com/<nuestra nube>`).
 * - Si un asset no se puede borrar, su fila SE CONSERVA para reintentarlo en
 *   la próxima pasada (así nunca quedan assets huérfanos).
 *
 * Corre sola una vez al día + bajo demanda (`POST /api/v1/storage/purge`).
 */

const PAGE = 500;

export interface RetentionRun {
  at: string;
  events: number;
  assets: number;
  assetFailures: number;
}

export const retentionStatus = {
  enabled: retentionSettings().enabled,
  daysEvents: retentionSettings().daysEvents,
  daysAssets: retentionSettings().daysAssets,
  lastRun: null as string | null,
  lastDeletedEvents: 0,
  lastDeletedAssets: 0,
  lastFailures: 0,
  running: false,
};

/**
 * `public_id` desde una secure_url propia (sin transformaciones en nuestras
 * URLs: `/<nube>/<image|video>/upload/v<ver>/<public_id>.<ext>`).
 * null = URL externa o con formato inesperado (no se toca).
 */
export function publicIdFromUrl(
  url: string,
  cloud: string
): { publicId: string; resourceType: "image" | "video" } | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "res.cloudinary.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] !== cloud) return null;
    const kind = parts[1];
    if (kind !== "image" && kind !== "video") return null;
    const uploadIdx = parts.indexOf("upload");
    if (uploadIdx === -1) return null;
    const rest = parts.slice(uploadIdx + 1);
    if (rest.length > 0 && /^v\d+$/.test(rest[0] as string)) rest.shift();
    if (rest.length === 0) return null;
    const last = rest[rest.length - 1] as string;
    rest[rest.length - 1] = last.replace(/\.[a-z0-9]+$/i, "");
    return { publicId: rest.join("/"), resourceType: kind };
  } catch {
    return null;
  }
}

export async function runRetention(reason: "schedule" | "manual" = "schedule"): Promise<RetentionRun> {
  const settings = retentionSettings();
  const result: RetentionRun = { at: new Date().toISOString(), events: 0, assets: 0, assetFailures: 0 };
  if (!settings.enabled || retentionStatus.running) return result;
  retentionStatus.running = true;
  try {
    const creds = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
    const attempted = new Set<string>();

    const destroyEventAssets = async (e: { snapshot: string | null; clip: string | null }): Promise<boolean> => {
      if (!creds) return true; // sin Cloudinary no hay nada que borrar
      let ok = true;
      for (const url of [e.snapshot, e.clip]) {
        if (!url) continue;
        const parsed = publicIdFromUrl(url, creds.cloud);
        if (!parsed) continue; // URL externa: no se toca ni bloquea
        const key = `${parsed.resourceType}:${parsed.publicId}`;
        if (attempted.has(key)) continue;
        attempted.add(key);
        let done = false;
        try {
          done = await deleteAsset(creds, parsed.publicId, 15000, parsed.resourceType);
        } catch {
          done = false;
        }
        if (done) result.assets += 1;
        else {
          result.assetFailures += 1;
          ok = false;
        }
      }
      return ok;
    };

    // 1. Assets de eventos viejos (aunque su fila se conserve por días distintos).
    const assetCutoff = new Date(Date.now() - settings.daysAssets * 86_400_000).toISOString();
    for (let offset = 0; ; offset += PAGE) {
      const batch = await listEventsForPurge(assetCutoff, PAGE, offset);
      if (batch.length === 0) break;
      for (const e of batch) await destroyEventAssets(e);
    }

    // 2. Filas viejas (+ sus assets restantes si días distintos): sólo se
    // borra la fila si sus assets salieron (o no tenía).
    const eventCutoff = new Date(Date.now() - settings.daysEvents * 86_400_000).toISOString();
    const ids: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const batch = await listEventsForPurge(eventCutoff, PAGE, offset);
      if (batch.length === 0) break;
      for (const e of batch) {
        if (await destroyEventAssets(e)) ids.push(e.id);
      }
    }
    result.events = await deleteEventsByIds(ids);

    retentionStatus.lastRun = result.at;
    retentionStatus.lastDeletedEvents = result.events;
    retentionStatus.lastDeletedAssets = result.assets;
    retentionStatus.lastFailures = result.assetFailures;
    console.log(
      `[retention] ${reason}: ${result.events} eventos y ${result.assets} assets borrados` +
        (result.assetFailures > 0 ? ` (${result.assetFailures} fallos, se reintentan)` : "")
    );
    return result;
  } finally {
    retentionStatus.running = false;
  }
}
