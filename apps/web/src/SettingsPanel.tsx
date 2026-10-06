import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type IntegrationsState } from "./api";

/**
 * Configuración de integraciones (Cloudinary + Supabase).
 *
 * Guarda `CLOUDINARY_URL` y `SUPABASE_SERVICE_KEY` (y `SUPABASE_URL`) sin
 * tocar el `.env` a mano: el server lo escribe y lo aplica en caliente.
 * Los secretos nunca se devuelven: sólo se muestra si hay key y una pista.
 */
export function SettingsPanel({ onAuthLost }: { onAuthLost: () => void }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<IntegrationsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [cloudUrl, setCloudUrl] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudTest, setCloudTest] = useState<string | null>(null);

  const [sbUrl, setSbUrl] = useState("");
  const [sbKey, setSbKey] = useState("");
  const [sbBusy, setSbBusy] = useState(false);
  const [sbTest, setSbTest] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.settings.get();
      setState(data);
      setError(null);
      return data;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return null;
      }
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [onAuthLost]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  function authLost(err: unknown): boolean {
    if (err instanceof ApiError && err.status === 401) {
      onAuthLost();
      return true;
    }
    return false;
  }

  async function handleSaveCloudinary(event: FormEvent) {
    event.preventDefault();
    setCloudBusy(true);
    setError(null);
    setNotice(null);
    setCloudTest(null);
    try {
      const res = await api.settings.saveCloudinary(cloudUrl.trim());
      setCloudUrl("");
      await load();
      setNotice(
        res.configured
          ? `Cloudinary guardado (☁️ ${res.cloudName}). Ya se pueden subir miniaturas y clips.`
          : "Cloudinary borrado: el server ya no subirá imágenes.",
      );
    } catch (err) {
      if (!authLost(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloudBusy(false);
    }
  }

  async function handleTestCloudinary() {
    setCloudBusy(true);
    setCloudTest(null);
    try {
      const res = await api.settings.testCloudinary(cloudUrl.trim() || undefined);
      setCloudTest(res.ok ? `✅ Cloudinary OK${res.cloud ? ` (${res.cloud})` : ""}${res.plan ? ` · plan ${res.plan}` : ""}` : `❌ ${res.error ?? "falló la comprobación"}`);
    } catch (err) {
      if (!authLost(err)) setCloudTest(`❌ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCloudBusy(false);
    }
  }

  async function handleSaveSupabase(event: FormEvent) {
    event.preventDefault();
    setSbBusy(true);
    setError(null);
    setNotice(null);
    setSbTest(null);
    try {
      const payload: { url?: string; serviceKey?: string } = {};
      if (sbUrl.trim()) payload.url = sbUrl.trim();
      if (sbKey.trim()) payload.serviceKey = sbKey.trim();
      if (Object.keys(payload).length === 0) {
        setError("Escribe la URL del proyecto y/o la service_role key.");
        return;
      }
      await api.settings.saveSupabase(payload);
      setSbKey("");
      const data = await load();
      setNotice(
        data?.supabase.configured
          ? `Supabase guardado (backend: ${data.supabase.backend}). Los datos ya persisten tras reiniciar.`
          : "Supabase guardado.",
      );
    } catch (err) {
      if (!authLost(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSbBusy(false);
    }
  }

  async function handleTestSupabase() {
    setSbBusy(true);
    setSbTest(null);
    try {
      const res = await api.settings.testSupabase({
        ...(sbUrl.trim() ? { url: sbUrl.trim() } : {}),
        ...(sbKey.trim() ? { serviceKey: sbKey.trim() } : {}),
      });
      if (res.ok) setSbTest(`✅ ${res.message ?? res.warning ?? "Supabase OK"}`);
      else setSbTest(`❌ ${res.error ?? "falló la comprobación"}`);
    } catch (err) {
      if (!authLost(err)) setSbTest(`❌ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSbBusy(false);
    }
  }

  async function handleClearSupabaseKey() {
    if (!confirm("¿Borrar la SUPABASE_SERVICE_KEY? El server volverá a modo memoria (se pierde la persistencia).")) return;
    setSbBusy(true);
    try {
      await api.settings.saveSupabase({ clearKey: true });
      await load();
      setNotice("SUPABASE_SERVICE_KEY borrada: el server usa memoria (sin persistencia).");
    } catch (err) {
      if (!authLost(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSbBusy(false);
    }
  }

  const sb = state?.supabase ?? null;
  const cloud = state?.cloudinary ?? null;

  return (
    <details className="card-panel settings-panel" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        ⚙️ Configuración <span className="muted">(Cloudinary · Supabase)</span>
      </summary>

      <p className="hint" style={{ marginTop: 12 }}>
        Pega aquí las credenciales en vez de editar el <code>.env</code> a mano. Se guardan en el servidor
        (sólo <em>owner</em>) y se aplican sin reiniciar. Los secretos nunca se muestran: sólo si hay clave.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      {!state ? (
        <p className="hint">{open ? "Cargando…" : ""}</p>
      ) : (
        <>
          <h3 style={{ margin: "18px 0 10px", fontSize: 14 }}>
            ☁️ Cloudinary{" "}
            <span className="muted">
              {cloud?.configured ? `· configurado (${cloud.cloudName})` : "· sin configurar (CLOUDINARY_URL)"}
            </span>
          </h3>
          <p className="hint" style={{ marginTop: 0 }}>
            Dashboard → <em>Product Environment Credentials</em> → <em>Project environment variable</em>.
            Formato: <code>cloudinary://&lt;api_key&gt;:&lt;api_secret&gt;@&lt;cloud_name&gt;</code>
            {cloud?.configured && cloud.urlHint ? (
              <>
                {" "}· actual: <code>{cloud.urlHint}</code> (carpeta <code>{cloud.folder}</code>)
              </>
            ) : null}
            . Sin esto no hay miniaturas ni fotos de avisos.
          </p>
          <form className="form-grid" onSubmit={handleSaveCloudinary}>
            <label style={{ gridColumn: "1 / -1" }}>
              CLOUDINARY_URL
              <input
                value={cloudUrl}
                onChange={(e) => setCloudUrl(e.target.value)}
                placeholder="cloudinary://123456:abcdef@mi-nube"
                autoComplete="off"
                spellCheck={false}
                type="password"
              />
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="submit" disabled={cloudBusy}>
                {cloudBusy ? "Guardando…" : "Guardar Cloudinary"}
              </button>
              <button type="button" className="ghost" onClick={() => void handleTestCloudinary()} disabled={cloudBusy}>
                Probar conexión
              </button>
            </div>
          </form>
          {cloudTest && (
            <p className="hint" style={{ marginBottom: 0 }}>
              {cloudTest}
            </p>
          )}

          <h3 style={{ margin: "22px 0 10px", fontSize: 14 }}>
            🗄️ Supabase{" "}
            <span className="muted">
              {sb?.configured ? `· configurado (backend ${sb.backend})` : "· sin configurar (modo memoria)"}
            </span>
          </h3>
          <p className="hint" style={{ marginTop: 0 }}>
            <em>Project Settings</em> → <em>API</em> → copia la <strong>service_role</strong> (no la anon).
            URL base sin <code>/rest/v1</code>
            {sb?.url ? (
              <>
                {" "}· actual: <code>{sb.url}</code>
              </>
            ) : null}
            {sb?.hasKey ? (
              <>
                {" "}· key: <code>{sb.keyHint}</code>
              </>
            ) : (
              <> · sin key</>
            )}
            {sb?.schemaStatus && typeof sb.schemaStatus.ok === "boolean" && !sb.schemaStatus.ok ? (
              <>
                {" "}· ⚠️ faltan tablas: <code>{sb.schemaStatus.missing.join(", ")}</code> (ejecuta{" "}
                <code>supabase/migrations/0001_init.sql</code>)
              </>
            ) : null}
            . Sin key todo funciona pero se pierde al reiniciar.
          </p>
          <form className="form-grid" onSubmit={handleSaveSupabase}>
            <label>
              SUPABASE_URL
              <input
                value={sbUrl}
                onChange={(e) => setSbUrl(e.target.value)}
                placeholder="https://xxxx.supabase.co"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              SUPABASE_SERVICE_KEY
              <input
                value={sbKey}
                onChange={(e) => setSbKey(e.target.value)}
                placeholder="sb_secret_… o eyJ…"
                autoComplete="off"
                spellCheck={false}
                type="password"
              />
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
              <button type="submit" disabled={sbBusy}>
                {sbBusy ? "Guardando…" : "Guardar Supabase"}
              </button>
              <button type="button" className="ghost" onClick={() => void handleTestSupabase()} disabled={sbBusy}>
                Probar conexión
              </button>
              {sb?.hasKey && (
                <button type="button" className="ghost" onClick={() => void handleClearSupabaseKey()} disabled={sbBusy}>
                  Borrar key
                </button>
              )}
            </div>
          </form>
          {sbTest && (
            <p className="hint" style={{ marginBottom: 0 }}>
              {sbTest}
            </p>
          )}
        </>
      )}
    </details>
  );
}
