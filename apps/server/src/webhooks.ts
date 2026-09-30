import { randomUUID } from "node:crypto";
import {
  newWebhookSecret,
  signWebhook,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "@cameras/core";

/**
 * F6 — webhooks: el server avisa a otras apps cuando ocurre un evento.
 *
 * El registro vive en memoria (se siembra con `WEBHOOK_URL`/`WEBHOOK_SECRET`
 * en .env y se gestiona con `POST/DELETE /api/v1/webhooks`). Cada envío lleva
 * HMAC-SHA256 firmado con el secreto del webhook para que el receptor pueda
 * comprobar que viene de Cameras Center y no ha sido manipulado.
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
  console.log(`[webhooks] + ${record.id.slice(0, 8)} → ${url}`);
  return { webhook: toView(record), secret };
}

export function removeWebhook(id: string): boolean {
  const index = records.findIndex((record) => record.id === id);
  if (index === -1) return false;
  const [removed] = records.splice(index, 1);
  console.log(`[webhooks] − ${id.slice(0, 8)} → ${removed?.url ?? ""}`);
  return true;
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
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "cameras-center/0.1.0",
    [WEBHOOK_EVENT_HEADER]: eventType,
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: signWebhook(record.secret, timestamp, body),
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
    secret,
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
