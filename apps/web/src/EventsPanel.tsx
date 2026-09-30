import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type MotionEvent, type WebhookInfo, type WebhookStats } from "./api";

/**
 * F6 — avisos de movimiento y webhooks.
 *
 * El agent mide el cambio de escena con FFmpeg; cuando supera el umbral manda
 * la foto del momento, el server la sube a Cloudinary, guarda el evento y
 * avisa a los webhooks registrados (`x-cameras-signature`).
 */
export function EventsPanel({ onAuthLost }: { onAuthLost: () => void }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<MotionEvent[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookInfo[]>([]);
  const [stats, setStats] = useState<WebhookStats | null>(null);
  const [url, setUrl] = useState("");
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [eventList, webhookData] = await Promise.all([
        api.events.list(24),
        api.webhooks.list().catch(() => null),
      ]);
      setEvents(eventList);
      if (webhookData) {
        setWebhooks(webhookData.webhooks);
        setStats(webhookData.stats);
      }
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onAuthLost]);

  useEffect(() => {
    if (!open) return;
    void load();
    const id = setInterval(() => void load(), 15000);
    return () => clearInterval(id);
  }, [open, load]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFreshSecret(null);
    try {
      const created = await api.webhooks.create({ url });
      setFreshSecret(created.secret);
      setUrl("");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(webhook: WebhookInfo) {
    if (!confirm(`¿Eliminar el webhook "${webhook.url}"?`)) return;
    try {
      await api.webhooks.remove(webhook.id);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemoveEvent(item: MotionEvent) {
    try {
      await api.events.remove(item.id);
      setEvents((prev) => prev.filter((entry) => entry.id !== item.id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copySecret() {
    if (!freshSecret) return;
    try {
      await navigator.clipboard.writeText(freshSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("No se pudo copiar: selecciona el secreto y cópialo a mano.");
    }
  }

  return (
    <details
      className="card-panel events-panel"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        🚨 Movimiento y webhooks <span className="muted">({events.length})</span>
      </summary>

      <p className="hint" style={{ marginTop: 12 }}>
        El <em>agent</em> compara la escena con FFmpeg (<code>lavfi.scene_score</code>): al superar{" "}
        <code>MOTION_THRESHOLD</code> guarda la foto del momento en Cloudinary, la registra como evento y avisa a
        cada webhook con firma HMAC-SHA256. Además arranca un <strong>clip MP4</strong> (grabado en el{" "}
        <em>agent</em> y subido a Cloudinary): aparece aquí en cuanto está listo.
      </p>

      {error && <div className="error-banner">{error}</div>}

      <h3 style={{ margin: "18px 0 10px", fontSize: 14 }}>Últimos avisos y clips</h3>
      {events.length === 0 ? (
        <p className="hint">Sin eventos todavía: pase algo delante de la cámara y aparecerá aquí.</p>
      ) : (
        <div className="event-grid">
          {events.map((item) => (
            <figure className="event-card" key={item.id}>
              {item.clip ? (
                <video
                  className="event-clip"
                  src={item.clip}
                  poster={item.snapshot ?? undefined}
                  controls
                  preload="metadata"
                  playsInline
                />
              ) : item.snapshot ? (
                <a href={item.snapshot} target="_blank" rel="noreferrer">
                  <img src={item.snapshot} alt={item.cameraName ?? item.cameraId} loading="lazy" />
                </a>
              ) : (
                <div className="event-noimg">sin imagen</div>
              )}
              <figcaption>
                <strong>{item.cameraName ?? item.cameraId.slice(0, 8)}</strong>
                <span className="muted">{new Date(item.at).toLocaleString()}</span>
                {item.score !== null && <span className="event-score">{Math.round(item.score * 100)}%</span>}
                {item.clip && (
                  <span className="event-score" title="Clip grabado (F7)">
                    🎬
                  </span>
                )}
              </figcaption>
              <button type="button" className="ghost" onClick={() => void handleRemoveEvent(item)}>
                Borrar
              </button>
            </figure>
          ))}
        </div>
      )}

      <h3 style={{ margin: "22px 0 10px", fontSize: 14 }}>
        Webhooks{" "}
        {stats && (
          <span className="muted">
            ({stats.active} activos · {stats.deliveries} envíos · {stats.failures} fallos)
          </span>
        )}
      </h3>

      {freshSecret && (
        <div className="fresh-key">
          <strong>🔐 Webhook creado (el secreto se muestra una sola vez):</strong>
          <div className="fresh-key-row">
            <code>{freshSecret}</code>
            <button type="button" className="ghost" onClick={() => void copySecret()}>
              {copied ? "✓ Copiado" : "Copiar"}
            </button>
            <button type="button" className="ghost" onClick={() => setFreshSecret(null)}>
              Entendido
            </button>
          </div>
          <span className="muted">
            Úsalo para verificar <code>x-cameras-signature</code> = HMAC-SHA256(secreto, timestamp.cuerpo).
          </span>
        </div>
      )}

      <form className="form-grid" onSubmit={handleCreate}>
        <label>
          URL de destino
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mi-app.ejemplo/hooks/camaras"
            required
            type="url"
            maxLength={500}
          />
        </label>
        <button type="submit" disabled={busy || !url.trim()}>
          {busy ? "Creando…" : "Añadir webhook"}
        </button>
      </form>

      {webhooks.length > 0 && (
        <table className="keys-table">
          <thead>
            <tr>
              <th>URL</th>
              <th>Eventos</th>
              <th>Entregas</th>
              <th>Último estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {webhooks.map((webhook) => (
              <tr key={webhook.id}>
                <td className="event-url">{webhook.url}</td>
                <td>{webhook.events.join(" · ")}</td>
                <td>
                  {webhook.deliveries} ok / {webhook.failures} fallos
                </td>
                <td>
                  {webhook.lastStatus
                    ? `HTTP ${webhook.lastStatus} · ${webhook.lastAt ? new Date(webhook.lastAt).toLocaleTimeString() : "—"}`
                    : webhook.lastError
                      ? `✗ ${webhook.lastError}`
                      : "—"}
                </td>
                <td>
                  <button type="button" className="ghost" onClick={() => void handleRemove(webhook)}>
                    Borrar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
