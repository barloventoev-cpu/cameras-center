import { randomUUID } from "node:crypto";
import { parseCloudinaryUrl, uploadJpeg } from "@cameras/core";
import type { AgentClipReady, AgentEvent, EventSummary } from "@cameras/protocol";
import { hasSupabase } from "./config";
import { store } from "./store";
import { deliverWebhooks } from "./webhooks";

/**
 * F6 — eventos de movimiento.
 *
 * El agent detecta el cambio de escena con FFmpeg y manda `agent:event` con la
 * imagen del momento. El server:
 *   1. la sube a Cloudinary (public_id único `events/<cámara>/<ms>`),
 *   2. guarda la fila en `events` (type='motion', sin migración: la tabla ya
 *      existe desde F2 con `thumbnail_url` y `payload`),
 *   3. avisa a los webhooks registrados.
 *
 * F7 — clips:
 *
 *   El agent manda `agent:clipReady` con la URL de un MP4 ya subido. Si hay un
 *   aviso reciente de esa cámara se le pega el clip en `payload.clip`; si no,
 *   se crea una fila `type='clip'` (grabación pedida a mano). Todo sigue sin
 *   migración: el clip vive en `payload`.
 */

const EVENT_TYPE = "motion";
const FOLDER = process.env.CLOUDINARY_FOLDER || "cameras-center";
const MEMORY_LIMIT = 200;
/** F7: el clip se adhiere al aviso reciente si este no tiene más de… */
const CLIP_LINK_MS = 60_000;

/** Lo que se guarda en `payload.clip` de una fila de evento. */
interface ClipPayload {
  url: string;
  durationMs: number;
  bytes: number;
  at: number;
  trigger: "motion" | "manual";
}

export interface StoredEvent {
  id: string;
  cameraId: string;
  cameraName: string | null;
  type: string;
  score: number | null;
  at: number;
  createdAt: string;
  snapshot: string | null;
  /** F7: URL del clip MP4 asociado (null si no tiene). */
  clip: string | null;
}

export const eventStats = {
  received: 0,
  persisted: 0,
  snapshots: 0,
  snapshotFailures: 0,
  lastAt: null as number | null,
  lastError: null as string | null,
};

/** F7: qué ha pasado con los clips recibidos del agent. */
export const clipStats = {
  received: 0,
  attached: 0,
  created: 0,
  failures: 0,
  lastAt: null as number | null,
  lastError: null as string | null,
};

const memoryEvents: StoredEvent[] = [];

export async function recordAgentEvent(message: AgentEvent): Promise<StoredEvent | null> {
  eventStats.received += 1;
  const cameraName = await cameraNameOf(message.cameraId);

  const snapshot = await uploadSnapshot(message);
  const stored: StoredEvent = {
    id: "",
    cameraId: message.cameraId,
    cameraName,
    type: message.event,
    score: Number.isFinite(message.score) ? message.score : null,
    at: message.at,
    createdAt: new Date(message.at).toISOString(),
    snapshot,
    clip: null,
  };

  try {
    stored.id = await persist(stored, {
      score: stored.score,
      at: stored.at,
      agentEvent: message.event,
      snapshot: stored.snapshot,
    });
    eventStats.persisted += 1;
    eventStats.lastAt = Date.now();
  } catch (error) {
    eventStats.lastError = error instanceof Error ? error.message : String(error);
    console.warn("[events] ✗ no se pudo guardar:", eventStats.lastError);
    return null;
  }

  console.log(
    `[events] 🚨 ${stored.cameraName ?? stored.cameraId} score=${stored.score ?? "?"} ${stored.snapshot ? "→ imagen subida" : "sin imagen"}`,
  );
  try {
    const result = await deliverWebhooks({
      id: stored.id,
      type: stored.type,
      camera: { id: stored.cameraId, name: stored.cameraName },
      at: stored.at,
      createdAt: stored.createdAt,
      score: stored.score,
      snapshot: stored.snapshot,
      // F7: el clip llega después (o no llega); sólo se informa si existe
      ...(stored.clip ? { clip: stored.clip } : {}),
      source: "cameras-center",
    });
    if (result.attempted > 0) {
      console.log(`[events] → webhooks ${result.delivered}/${result.attempted} OK${result.failed ? `, ${result.failed} con fallo` : ""}`);
    }
  } catch (error) {
    console.warn("[events] error enviando webhooks:", error instanceof Error ? error.message : error);
  }

  return stored;
}

/**
 * F7 — el agent avisa de un clip grabado y subido.
 *
 * Si hay un aviso de movimiento reciente de esa cámara (≤ 60 s) el clip se le
 * pega en `payload.clip`: es *su* vídeo. Si no (grabación manual, o el aviso no
 * se pudo guardar) se crea una fila `type='clip'`.
 */
export async function recordAgentClip(message: AgentClipReady): Promise<StoredEvent | null> {
  clipStats.received += 1;
  const cameraName = await cameraNameOf(message.cameraId);
  const clip: ClipPayload = {
    url: message.url,
    durationMs: message.durationMs,
    bytes: message.bytes,
    at: message.at,
    trigger: message.trigger,
  };

  try {
    const recent = await listEvents({ type: EVENT_TYPE, cameraId: message.cameraId, limit: 1 });
    const target = recent[0] ?? null;

    if (target && Date.now() - target.at <= CLIP_LINK_MS) {
      await attachClip(target.id, clip);
      target.clip = message.url;
      clipStats.attached += 1;
      clipStats.lastAt = Date.now();
      console.log(
        `[events] 🎬 clip ${message.bytes} B pegado al aviso ${target.id} (${message.durationMs} ms, ${message.trigger})`,
      );
      return target;
    }

    const stored: StoredEvent = {
      id: "",
      cameraId: message.cameraId,
      cameraName,
      type: "clip",
      score: null,
      at: message.at,
      createdAt: new Date(message.at).toISOString(),
      snapshot: null,
      clip: message.url,
    };
    stored.id = await persist(stored, {
      at: stored.at,
      agentEvent: "clip",
      clip,
      trigger: message.trigger,
    });
    clipStats.created += 1;
    clipStats.lastAt = Date.now();
    console.log(
      `[events] 🎬 evento clip ${stored.id} creado (${message.durationMs} ms, ${message.trigger})`,
    );

    // un clip manual es un evento como cualquier otro: se notifica igualmente
    await deliverWebhooks({
      id: stored.id,
      type: stored.type,
      camera: { id: stored.cameraId, name: stored.cameraName },
      at: stored.at,
      createdAt: stored.createdAt,
      score: null,
      snapshot: null,
      clip: stored.clip ?? undefined,
      source: "cameras-center",
    }).catch(() => undefined);

    return stored;
  } catch (error) {
    clipStats.failures += 1;
    clipStats.lastError = error instanceof Error ? error.message : String(error);
    console.warn("[events] ✗ clip no guardado:", clipStats.lastError);
    return null;
  }
}

export interface ListEventsOptions {
  type?: string;
  cameraId?: string;
  limit?: number;
}

export async function listEvents(options: ListEventsOptions = {}): Promise<StoredEvent[]> {
  const type = options.type ?? EVENT_TYPE;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const names = await cameraNames();

  if (hasSupabase) {
    try {
      const { getSupabase } = await import("./db/supabase");
      let query = getSupabase()
        .from("events")
        .select("*")
        .eq("type", type)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (options.cameraId) query = query.eq("camera_id", options.cameraId);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => rowToEvent(row, names));
    } catch (error) {
      console.warn("[events] no se pudo leer Supabase:", error instanceof Error ? error.message : error);
    }
  }

  return memoryEvents
    .filter((event) => event.type === type && (!options.cameraId || event.cameraId === options.cameraId))
    .slice(0, limit);
}

export async function removeEvent(id: string): Promise<boolean> {
  const index = memoryEvents.findIndex((event) => event.id === id);
  if (index !== -1) memoryEvents.splice(index, 1);

  if (hasSupabase) {
    try {
      const { getSupabase } = await import("./db/supabase");
      const { data, error } = await getSupabase().from("events").delete().eq("id", id).select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    } catch (error) {
      console.warn("[events] no se pudo borrar:", error instanceof Error ? error.message : error);
      return false;
    }
  }
  return index !== -1;
}

export interface PurgeCandidate {
  id: string;
  snapshot: string | null;
  clip: string | null;
}

/**
 * Eventos viejos (motion/clip) para la purga de retención, del más antiguo
 * al más nuevo. Las miniaturas F4 (una por cámara) nunca se tocan.
 */
export async function listEventsForPurge(
  beforeIso: string,
  limit: number,
  offset: number
): Promise<PurgeCandidate[]> {
  if (hasSupabase) {
    try {
      const { getSupabase } = await import("./db/supabase");
      const { data, error } = await getSupabase()
        .from("events")
        .select("id, thumbnail_url, payload")
        .in("type", ["motion", "clip"])
        .lt("created_at", beforeIso)
        .order("created_at", { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => {
        const r = row as { id: string; thumbnail_url?: string | null; payload?: { clip?: { url?: unknown } } | null };
        const clipUrl = r.payload?.clip && typeof r.payload.clip.url === "string" ? r.payload.clip.url : null;
        return { id: r.id, snapshot: r.thumbnail_url ?? null, clip: clipUrl };
      });
    } catch (error) {
      console.warn("[events] no se pudo listar para purga:", error instanceof Error ? error.message : error);
      return [];
    }
  }
  return memoryEvents
    .filter((e) => (e.type === "motion" || e.type === "clip") && e.createdAt < beforeIso)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .slice(offset, offset + limit)
    .map((e) => ({ id: e.id, snapshot: e.snapshot, clip: e.clip ?? null }));
}

/** Borra filas por id (en lotes). Devuelve cuántas se borraron. */
export async function deleteEventsByIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const dropMemory = () => {
    let n = 0;
    for (const id of ids) {
      const idx = memoryEvents.findIndex((e) => e.id === id);
      if (idx !== -1) {
        memoryEvents.splice(idx, 1);
        n += 1;
      }
    }
    return n;
  };
  if (hasSupabase) {
    try {
      const { getSupabase } = await import("./db/supabase");
      let deleted = 0;
      for (let i = 0; i < ids.length; i += 500) {
        const { error, count } = await getSupabase()
          .from("events")
          .delete({ count: "exact" })
          .in("id", ids.slice(i, i + 500));
        if (error) throw new Error(error.message);
        deleted += count ?? 0;
      }
      dropMemory();
      return deleted;
    } catch (error) {
      console.warn("[events] no se pudo purgar:", error instanceof Error ? error.message : error);
      return 0;
    }
  }
  return dropMemory();
}

export async function eventCount(type = EVENT_TYPE): Promise<number> {
  if (hasSupabase) {
    try {
      const { getSupabase } = await import("./db/supabase");
      const { count, error } = await getSupabase()
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("type", type);
      if (!error && typeof count === "number") return count;
    } catch {
      // cae al contador en memoria
    }
  }
  return memoryEvents.filter((event) => event.type === type).length;
}

export async function latestEvent(): Promise<StoredEvent | null> {
  const events = await listEvents({ limit: 1 });
  return events[0] ?? null;
}

export function toSummary(event: StoredEvent): EventSummary {
  return {
    id: event.id,
    cameraId: event.cameraId,
    cameraName: event.cameraName,
    type: event.type,
    score: event.score,
    at: event.at,
    createdAt: event.createdAt,
    snapshot: event.snapshot,
    clip: event.clip,
  };
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

async function uploadSnapshot(message: AgentEvent): Promise<string | null> {
  if (!message.jpegBase64) return null;
  const creds = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
  if (!creds) return null;

  try {
    const jpeg = Buffer.from(message.jpegBase64, "base64");
    if (jpeg.length === 0) throw new Error("imagen vacía");
    // public_id único por aviso: la foto de CADA evento se conserva (a diferencia
    // de la miniatura de F4, que sí se sobrescribe). El sufijo aleatorio evita
    // que dos avisos en el mismo milisegundo compartan imagen.
    const result = await uploadJpeg(jpeg, creds, {
      folder: FOLDER,
      publicId: `events/${message.cameraId}/${message.at}-${randomUUID().slice(0, 8)}`,
      overwrite: false,
    });
    eventStats.snapshots += 1;
    return result.url;
  } catch (error) {
    eventStats.snapshotFailures += 1;
    eventStats.lastError = error instanceof Error ? error.message : String(error);
    console.warn(`[events] ✗ snapshot ${message.cameraId.slice(0, 8)}:`, eventStats.lastError);
    return null;
  }
}

async function persist(event: StoredEvent, payload: Record<string, unknown>): Promise<string> {
  if (!hasSupabase) {
    const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    memoryEvents.unshift({ ...event, id });
    if (memoryEvents.length > MEMORY_LIMIT) memoryEvents.length = MEMORY_LIMIT;
    return id;
  }

  const { getSupabase } = await import("./db/supabase");
  const { data, error } = await getSupabase()
    .from("events")
    .insert({
      camera_id: event.cameraId,
      type: event.type,
      thumbnail_url: event.snapshot,
      payload,
    })
    .select("id, created_at")
    .single();
  if (error) throw new Error(error.message);

  const row = data as { id: string; created_at: string };
  event.createdAt = new Date(row.created_at).toISOString();
  return row.id;
}

/**
 * F7: pega el clip al payload de la fila (mezcla, no sobrescribe: el aviso
 * conserva su `score`/`snapshot`). En memoria el clip ya vive en el propio
 * evento, así que sólo se actualiza el mapa.
 */
async function attachClip(id: string, clip: ClipPayload): Promise<void> {
  const memory = memoryEvents.find((event) => event.id === id);
  if (memory) {
    memory.clip = clip.url;
    return;
  }

  const { getSupabase } = await import("./db/supabase");
  const client = getSupabase();
  const { data, error } = await client.from("events").select("payload").eq("id", id).single();
  if (error) throw new Error(error.message);
  const payload = { ...(((data ?? {}) as { payload?: Record<string, unknown> }).payload ?? {}), clip };
  const { error: updateError } = await client.from("events").update({ payload }).eq("id", id);
  if (updateError) throw new Error(updateError.message);
}

interface EventRow {
  id: string;
  camera_id: string | null;
  type: string;
  thumbnail_url: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

function rowToEvent(row: EventRow, names: Map<string, string>): StoredEvent {
  const payload = row.payload ?? {};
  const at = Number(payload.at ?? Date.parse(row.created_at));
  const clip = payload.clip as ClipPayload | undefined;
  return {
    id: row.id,
    cameraId: row.camera_id ?? "",
    cameraName: row.camera_id ? (names.get(row.camera_id) ?? null) : null,
    type: row.type,
    score: typeof payload.score === "number" ? payload.score : null,
    at: Number.isFinite(at) ? at : Date.now(),
    createdAt: new Date(row.created_at).toISOString(),
    snapshot: row.thumbnail_url,
    clip: clip && typeof clip.url === "string" ? clip.url : null,
  };
}

async function cameraNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    for (const camera of await store.list()) map.set(camera.id, camera.name);
  } catch {
    // sin nombres la API sigue funcionando
  }
  return map;
}

async function cameraNameOf(cameraId: string): Promise<string | null> {
  try {
    return (await store.get(cameraId))?.name ?? null;
  } catch {
    return null;
  }
}

export { EVENT_TYPE as MOTION_EVENT_TYPE };
