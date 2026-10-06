import { randomUUID } from "node:crypto";
import {
  newWebhookSecret,
  signWebhook,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "@cameras/core";
import { protectConnection, revealConnection } from "./store";
import { hasSupabase } from "./config";

/**
 * F6 — webhooks: el server avisa a otras apps cuando ocurre un evento.
 *
 * El registro vive en memoria y se persiste en Supabase (tabla `webhooks`,
 * migración `0002_webhooks.sql`) para sobrevivir reinicios: al arrancar se
 * siembra con `WEBHOOK_URL`/`WEBHOOK_SECRET` y se cargan los guardados. Sin
 * Supabase (o sin la tabla) todo sigue funcionando en memoria como antes.
 * El secreto se guarda cifrado con `CAMERA_ENC_KEY` (igual que las URLs de
 * cámara) y sólo se revela al firmar cada envío; la API nunca lo devuelve.
 *
 *   POST <url>
 *   x-cameras-event:    motion
 *   x-cameras-timestamp: 1790723770
 *   x-cameras-signature: sha256=<hmac(timestamp.body)>
 */

const timeoutMs = intFromEnv("WEBHOOK_TIMEOUT_MS", 8000);
const attempts = intFromEnv("WEBHOOK_ATTEMPTS", 2, 1);
const retryDelayMs = intFromEnv("WEBHOOK_RETRY_MS", 1000, 0);

export interface WebhookRecord {
  id: string;
  url: string;
  /** Secreto HMAC: NUNCA se devuelve en la API después de crearlo. */
  secret: string;
  events: string[];
  active: boolean;
  createdAt: string;
  deliveries: number;
  failures: number;
  lastStatus: number | null;
  lastAt: string | null;
  lastError: string | null;
}

export type WebhookView = Omit<WebhookRecord, "secret">;

export interface WebhookPayload {
  id: string;
  type: string;
  camera: { id: string; name: string | null };
  at: number;
  createdAt: string;
  score: number | null;
  snapshot: string | null;
  /** F7: URL del clip MP4 si el evento lo tiene (sólo se informa si existe). */
  clip?: string;
  source: "cameras-center";
}

export const webhookStats = {
  seeded: 0,
  deliveries: 0,
  failures: 0,
  lastStatus: null as number | null,
  lastAt: null as string | null,
  lastError: null as string | null,
};

const records: WebhookRecord[] = [];

export function listWebhooks(): WebhookView[] {
  return records.map(toView);
}

export function activeWebhooks(): number {
  return records.filter((record) => record.active).length;
}

export function webhookInfo() {
  return {
    configured: records.length > 0,
    total: records.length,
    active: activeWebhooks(),
    seeded: webhookStats.seeded,
    timeoutMs,
    attempts,
    deliveries: records.reduce((sum, record) => sum + record.deliveries, 0),
    failures: records.reduce((sum, record) => sum + record.failures, 0),
    lastStatus: webhookStats.lastStatus,
    lastAt: webhookStats.lastAt,
    lastError: webhookStats.lastError,
  };
}

/** Sembrado al arrancar: `WEBHOOK_URL` acepta varias URLs separadas por coma. */
export function seedWebhooksFromEnv(): void {
  const raw = (process.env.WEBHOOK_URL ?? "").trim();
  if (!raw) return;
  const secret = (process.env.WEBHOOK_SECRET ?? "").trim() || newWebhookSecret();

  for (const url of raw.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    if (!isAllowedUrl(url)) {
      console.warn(`[webhooks] ✗ URL no válida ignorada: ${url.slice(0, 80)}`);
      continue;
    }
    records.push(createRecord(url, secret));
    webhookStats.seeded += 1;
  }
  if (webhookStats.seeded > 0) console.log(`[webhooks] ✅ ${webhookStats.seeded} webhook(s) desde WEBHOOK_URL`);
}

export function createWebhook(input: { url: string; secret?: string; events?: string[] }): { webhook: WebhookView; secret: string } {
  const url = input.url.trim();
  if (!isAllowedUrl(url)) throw new Error("La URL debe empezar por http:// o https://");
  const secret = (input.secret ?? "").trim() || newWebhookSecret();
  const record = createRecord(url, secret, input.events);
  records.push(record);
  void persistWebhook(record).catch(() => undefined);
  console.log(`[webhooks] + ${record.id.slice(0, 8)} → ${url}`);
  return { webhook: toView(record), secret };
}

export async function removeWebhook(id: string): Promise<boolean> {
  const index = records.findIndex((record) => record.id === id);
  if (index === -1) return false;
  const [removed] = records.splice(index, 1);
  if (hasSupabase()) {
    try {
      const { getSupabase } = await import("./db/supabase");
      const { error } = await getSupabase().from("webhooks").delete().eq("id", id);
      if (error) throw new Error(error.message);
    } catch (error) {
      console.warn("[webhooks] no se pudo borrar en Supabase:", error instanceof Error ? error.message : error);
    }
  }
  console.log(`[webhooks] − ${id.slice(0, 8)} → ${removed?.url ?? ""}`);
  return true;
}

/**
 * Carga los webhooks guardados en Supabase (tras sembrar los de .env; las
 * URLs duplicadas no se repiten). Sin Supabase o sin la tabla se sigue sólo
 * con memoria (ver `supabase/migrations/0002_webhooks.sql`).
 */
export async function loadPersistedWebhooks(): Promise<number> {
  if (!hasSupabase()) return 0;
  try {
    const { getSupabase } = await import("./db/supabase");
    const { data, error } = await getSupabase()
      .from("webhooks")
      .select("id, url, secret, events, active, created_at")
      .eq("active", true)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    let loaded = 0;
    for (const row of (data ?? []) as Array<{
      id: string;
      url: string;
      secret: string;
      events?: string[] | null;
      active?: boolean | null;
      created_at?: string | null;
    }>) {
      if (!row?.url || records.some((r) => r.url === row.url)) continue;
      records.push({
        id: row.id,
        url: row.url,
        secret: row.secret,
        events: Array.isArray(row.events) && row.events.length > 0 ? row.events : ["motion"],
        active: row.active !== false,
        createdAt: row.created_at ?? new Date().toISOString(),
        deliveries: 0,
        failures: 0,
        lastStatus: null,
        lastAt: null,
        lastError: null,
      });
      loaded += 1;
    }
    if (loaded > 0) console.log(`[webhooks] ✅ ${loaded} webhook(s) recuperados de Supabase`);
    return loaded;
  } catch (error) {
    console.warn("[webhooks] sin persistencia (falta la tabla webhooks?):", error instanceof Error ? error.message : error);
    return 0;
  }
}

async function persistWebhook(record: WebhookRecord): Promise<void> {
  if (!hasSupabase()) return;
  try {
    const { getSupabase } = await import("./db/supabase");
    const { error } = await getSupabase().from("webhooks").upsert(
      {
        id: record.id,
        url: record.url,
        secret: record.secret,
        events: record.events,
        active: record.active,
      },
      { onConflict: "id" }
    );
    if (error) throw new Error(error.message);
  } catch (error) {
    console.warn("[webhooks] no se pudo guardar en Supabase:", error instanceof Error ? error.message : error);
  }
}

/** Envía el evento a todos los webhooks activos suscritos a su tipo. */
export async function deliverWebhooks(payload: WebhookPayload): Promise<{ attempted: number; delivered: number; failed: number }> {
  const targets = records.filter((record) => record.active && record.events.includes(payload.type));
  if (targets.length === 0) return { attempted: 0, delivered: 0, failed: 0 };

  // el mismo body para todos: el receptor puede deduplicar por `id`
  const body = JSON.stringify(payload);
  const deliveryId = randomUUID();
  let delivered = 0;
  let failed = 0;

  for (const record of targets) {
    const ok = await deliver(record, body, payload.type, deliveryId);
    if (ok) delivered += 1;
    else failed += 1;
  }

  return { attempted: targets.length, delivered, failed };
}

async function deliver(record: WebhookRecord, body: string, eventType: string, deliveryId: string): Promise<boolean> {
  const timestamp = Math.floor(Date.now() / 1000);
  let secret: string;
  try {
    secret = revealConnection(record.secret);
  } catch (error) {
    record.lastError = error instanceof Error ? error.message : String(error);
    record.failures += 1;
    webhookStats.failures += 1;
    return false;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "cameras-center/0.1.0",
    [WEBHOOK_EVENT_HEADER]: eventType,
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, timestamp, body),
    "x-cameras-delivery": deliveryId,
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(record.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      record.lastStatus = response.status;
      webhookStats.lastStatus = response.status;

      if (response.ok) {
        record.deliveries += 1;
        record.lastAt = new Date().toISOString();
        record.lastError = null;
        webhookStats.deliveries += 1;
        webhookStats.lastAt = record.lastAt;
        webhookStats.lastError = null;
        return true;
      }
      record.lastError = `HTTP ${response.status}`;
      webhookStats.lastError = record.lastError;
    } catch (error) {
      record.lastError = error instanceof Error ? error.message : String(error);
      webhookStats.lastError = record.lastError;
      record.lastStatus = null;
      webhookStats.lastStatus = null;
    }
    if (attempt < attempts && retryDelayMs > 0) await sleep(retryDelayMs);
  }

  record.failures += 1;
  record.lastAt = new Date().toISOString();
  webhookStats.failures += 1;
  webhookStats.lastAt = record.lastAt;
  console.warn(`[webhooks] ✗ ${record.id.slice(0, 8)} ${record.url.slice(0, 60)}: ${record.lastError ?? "fallo"}`);
  return false;
}

function createRecord(url: string, secret: string, events?: string[]): WebhookRecord {
  return {
    id: randomUUID(),
    url,
    // En reposo va cifrado (igual que las URLs de cámara); se revela al firmar.
    secret: protectConnection(secret),
    events: events && events.length > 0 ? events : ["motion"],
    active: true,
    createdAt: new Date().toISOString(),
    deliveries: 0,
    failures: 0,
    lastStatus: null,
    lastAt: null,
    lastError: null,
  };
}

function toView(record: WebhookRecord): WebhookView {
  const { secret: _secret, ...view } = record;
  return view;
}

function isAllowedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function intFromEnv(name: string, fallback: number, min = 1): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}
