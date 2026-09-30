import { randomUUID } from "node:crypto";
import { parseCloudinaryUrl, uploadJpeg } from "@cameras/core";
import type { AgentEvent, EventSummary } from "@cameras/protocol";
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
 */

const EVENT_TYPE = "motion";
const FOLDER = process.env.CLOUDINARY_FOLDER || "cameras-center";
const MEMORY_LIMIT = 200;

export interface StoredEvent {
  id: string;
  cameraId: string;
  cameraName: string | null;
  type: string;
  score: number | null;
  at: number;
  createdAt: string;
  snapshot: string | null;
}

export const eventStats = {
  received: 0,
  persisted: 0,
  snapshots: 0,
  snapshotFailures: 0,
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
  };

  try {
    stored.id = await persist(stored, message);
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

export function toSummary(event: StoredEvent): EventSummary {  return {
    id: event.id,
    cameraId: event.cameraId,
    cameraName: event.cameraName,
    type: event.type,
    score: event.score,
    at: event.at,
    createdAt: event.createdAt,
    snapshot: event.snapshot,
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

async function persist(event: StoredEvent, message: AgentEvent): Promise<string> {
  const payload = {
    score: event.score,
    at: event.at,
    agentEvent: message.event,
    snapshot: event.snapshot,
  };

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
  return {
    id: row.id,
    cameraId: row.camera_id ?? "",
    cameraName: row.camera_id ? (names.get(row.camera_id) ?? null) : null,
    type: row.type,
    score: typeof payload.score === "number" ? payload.score : null,
    at: Number.isFinite(at) ? at : Date.now(),
    createdAt: new Date(row.created_at).toISOString(),
    snapshot: row.thumbnail_url,
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
