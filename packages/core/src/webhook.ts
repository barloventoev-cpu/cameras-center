import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Firma de webhooks (F6).
 *
 * El emisor calcula HMAC-SHA256 sobre `${timestamp}.${body}` con un secreto
 * compartido y lo manda en `X-Cameras-Signature: sha256=<hex>`. El receptor
 * recalcula y compara (en tiempo constante) dentro de una ventana de ±5 min,
 * de modo que un body reenviado por un tercero sin el secreto no valida.
 */

export const WEBHOOK_SIGNATURE_HEADER = "x-cameras-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-cameras-timestamp";
export const WEBHOOK_EVENT_HEADER = "x-cameras-event";

/** Ventana (s) en la que se acepta un `timestamp` reenviado. */
export const WEBHOOK_TOLERANCE_SEC = 300;

export function signWebhook(secret: string, timestamp: string | number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Comprobación del receptor: firma válida y timestamp dentro de la ventana. */
export function verifyWebhookSignature(options: {
  secret: string;
  timestamp: string | number;
  body: string;
  signature: string;
  nowMs?: number;
}): boolean {
  const { secret, timestamp, body, signature } = options;
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > WEBHOOK_TOLERANCE_SEC) return false;

  const expected = Buffer.from(signWebhook(secret, ts, body), "utf8");
  const received = Buffer.from(String(signature ?? ""), "utf8");
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

/** Secreto nuevo para un webhook creado por API (`whsec_…`). */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}
