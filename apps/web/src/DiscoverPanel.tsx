import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type DiscoverResult, type DiscoveredHost } from "./api";

/**
 * F8 — búsqueda automática de cámaras en la red local.
 *
 * El barrido lo hace el **agent** (es el único que está en la LAN): el server
 * sólo correlaciona la petición con la respuesta por WebSocket. Dos sondas en
 * paralelo:
 *
 *   TCP  → puertos típicos de cámaras; en los host vivos, HTTP y `DESCRIBE` RTSP
 *   ONVIF→ M-SEARCH WS-Discovery → marca, modelo y URL RTSP (GetStreamUri)
 *
 * «Usar» rellena el formulario de alta de cámaras de arriba con la URL
 * candidata: sólo falta añadir usuario y contraseña.
 */
export function DiscoverPanel({
  onAuthLost,
  onUseCamera,
}: {
  onAuthLost: () => void;
  onUseCamera: (input: { name: string; connection: string; sourceType: "rtsp" }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [subnet, setSubnet] = useState("");
  const [onvif, setOnvif] = useState(true);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Reloj mientras busca: el usuario tiene que ver que algo pasa.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [busy]);

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const found = await api.discover({ subnet: subnet.trim() || undefined, onvif });
      setResult(found);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function useCamera(host: DiscoveredHost) {
    if (!host.suggestion) return;
    onUseCamera({ name: `Cámara ${host.ip}`, connection: host.suggestion, sourceType: "rtsp" });
  }

  async function copySuggestion(host: DiscoveredHost) {
    if (!host.suggestion) return;
    try {
      await navigator.clipboard.writeText(host.suggestion);
      setCopied(host.ip);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("No se pudo copiar: selecciona la URL y cópiala a mano.");
    }
  }

  return (
    <details
      className="card-panel discover-panel"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary>
        📡 Descubrir cámaras en la red <span className="muted">{result ? `(${result.hosts.length})` : ""}</span>
      </summary>

      <p className="hint" style={{ marginTop: 12 }}>
        El <em>agent</em> barre la subred por <strong>TCP</strong> (80, 443, 554, 8554, 8080, 10554…) y sondea{" "}
        <strong>HTTP</strong> y <strong>RTSP</strong> en cada host vivo; en paralelo manda un M-SEARCH{" "}
        <strong>ONVIF</strong> (WS-Discovery) para leer marca, modelo y URL RTSP. Tarda de 5 a 30 s y necesita el
        agent conectado, porque la red la ve sólo él.
      </p>

      {error && <div className="error-banner">{error}</div>}

      <form className="form-grid" onSubmit={handleSearch}>
        <label>
          Subred (opcional)
          <input
            value={subnet}
            onChange={(e) => setSubnet(e.target.value)}
            placeholder="192.168.1.0/24 — vacío = la del agent"
            maxLength={64}
            pattern="\s*(\d{1,3}\.){3}\d{1,3}/\d{1,2}\s*"
            title="Formato x.x.x.0/24 (déjalo vacío para la subred por defecto)"
          />
        </label>
        <label style={{ justifyContent: "center" }}>
          <span style={{ display: "flex", gap: 8, alignItems: "center", flexDirection: "row", fontWeight: 400 }}>
            <input type="checkbox" checked={onvif} onChange={(e) => setOnvif(e.target.checked)} />
            incluir sondeo ONVIF
          </span>
        </label>
        <button type="submit" disabled={busy}>
          {busy ? `🔎 Buscando… ${elapsed}s` : "🔎 Buscar cámaras"}
        </button>
      </form>

      {busy && (
        <p className="hint">
          Barriendo la red: primero el TCP puerta por puerta y después el sondeo ONVIF. Si tarda, puede ser que la
          Wi-Fi aisle a los clientes o que la subred no sea la correcta.
        </p>
      )}

      {result && (
        <>
          <p className="hint" style={{ marginBottom: 8 }}>
            <strong>{result.hosts.length}</strong> host(s) con servicio de cámara/interfaz en{" "}
            <code>{result.subnet}</code> · {result.scanned} sondeados · {(result.elapsedMs / 1000).toFixed(1)} s
            {result.agentId ? ` · por el agent ${result.agentId}` : ""}
          </p>

          {result.hosts.length === 0 ? (
            <p className="hint">
              Nada encontrado. Comprueba que estás en la misma subred que las cámaras, que la Wi-Fi no tiene aislamiento
              de clientes y prueba con la subred exacta (por ejemplo <code>192.168.1.0/24</code>).
            </p>
          ) : (
            <table className="keys-table">
              <thead>
                <tr>
                  <th>IP</th>
                  <th>Puertos</th>
                  <th>RTSP</th>
                  <th>ONVIF</th>
                  <th>URL candidata</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.hosts.map((host) => (
                  <tr key={host.ip}>
                    <td>
                      <strong>{host.ip}</strong>
                    </td>
                    <td>
                      {host.open.join(" · ")}
                      {host.http && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          HTTP {host.http.port}
                          {host.http.server ? ` · ${host.http.server}` : ""}
                          {host.http.title && host.http.title !== "-" ? ` · ${host.http.title}` : ""}
                        </div>
                      )}
                    </td>
                    <td>
                      {host.rtsp?.ok ? (
                        <>
                          ✅ {host.rtsp.uri ?? "/"}
                          <div className="muted" style={{ fontSize: 12 }}>
                            {host.rtsp.banner}
                          </div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {host.onvif ? (
                        <>
                          {host.onvif.manufacturer ?? ""} {host.onvif.model ?? ""}
                          {host.onvif.authRequired && " 🔒"}
                          <div className="muted" style={{ fontSize: 12 }}>
                            {host.onvif.error ?? host.onvif.xaddr.replace(/^https?:\/\//, "")}
                          </div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="event-url">
                      {host.suggestion ? <code>{host.suggestion}</code> : <span className="muted">sin candidata</span>}
                    </td>
                    <td>
                      {host.suggestion && (
                        <>
                          <button
                            type="button"
                            className="ghost"
                            title="Rellena el formulario «Añadir cámara» con esta URL"
                            onClick={() => useCamera(host)}
                          >
                            Usar
                          </button>{" "}
                          <button type="button" className="ghost" onClick={() => void copySuggestion(host)}>
                            {copied === host.ip ? "✓ Copiada" : "Copiar"}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="hint" style={{ marginBottom: 0 }}>
            <strong>Usar</strong> rellena el formulario de arriba con la URL: añade <code>usuario:contraseña@</code>{" "}
            después del <code>rtsp://</code> antes de guardar. Si la marca no responde, prueba con las rutas típicas:{" "}
            <code>/Streaming/Channels/101</code> (Hikvision/EZVIZ) · <code>/tcp/av0_0</code> (O-KAM/EZVIZ) ·{" "}
            <code>/live</code> (genéricas).
          </p>
        </>
      )}
    </details>
  );
}
