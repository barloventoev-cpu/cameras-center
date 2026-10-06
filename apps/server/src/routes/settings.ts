import { Router } from "express";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { cloudinaryUsage, findUpEnvFile, parseCloudinaryUrl } from "@cameras/core";
import { applyRuntimeEnv, config, hasSupabase } from "../config";
import { getSchemaStatus, resetSupabaseClient, verifySchema } from "../db/supabase";
import { store } from "../store";
import { cloudinaryStatus } from "../thumbs";
import { requireAuth } from "../middleware/auth";

/**
 * Configuración de integraciones (Cloudinary + Supabase) desde la web.
 *
 * - `GET  /api/v1/settings/integrations` estado sin secretos (sólo JWT).
 * - `PUT  /api/v1/settings/cloudinary`   guarda CLOUDINARY_URL (sólo owner).
 * - `PUT  /api/v1/settings/supabase`     guarda SUPABASE_URL/SERVICE_KEY (sólo owner).
 * - `POST /api/v1/settings/cloudinary/test` comprueba la URL (sólo owner).
 * - `POST /api/v1/settings/supabase/test`   comprueba URL+key (sólo owner).
 *
 * Guardar escribe en el `.env` del monorepo Y lo aplica en memoria
 * (`process.env` + cliente Supabase), así no hace falta reiniciar.
 * Los secretos nunca se devuelven: sólo `configured` / `hasKey` y pistas.
 */
export const settingsRouter = Router();

function handleError(res: import("express").Response, error: unknown, context: string) {
  console.error(`[settings] ${context}:`, error);
  return res.status(500).json({ error: error instanceof Error ? error.message : "Error interno" });
}

function requireOwner(res: import("express").Response): boolean {
  if (res.locals.userRole !== "owner") {
    res.status(403).json({ error: "Sólo el usuario owner puede cambiar la configuración" });
    return false;
  }
  return true;
}

// --- .env -----------------------------------------------------------------
function envFilePath(): string {
  return findUpEnvFile(process.cwd()) ?? join(process.cwd(), ".env");
}

/** Inserta o reemplaza `KEY=valor` en el `.env` preservando comentarios. */
function upsertEnvFile(vars: Record<string, string>): string {
  const file = envFilePath();
  let lines: string[] = [];
  if (existsSync(file)) {
    lines = readFileSync(file, "utf8").split(/\r?\n/);
    // quita la última línea vacía fantasma para no duplicar saltos
    if (lines.length > 0 && lines[lines.length - 1] === "" && readFileSync(file, "utf8").endsWith("\n")) {
      lines = lines.slice(0, -1);
    }
  }
  const pending = new Map(Object.entries(vars));
  const out = lines.map((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key) ?? "";
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  writeFileSync(file, out.join("\n") + "\n", "utf8");
  return file;
}

// --- estado ---------------------------------------------------------------
function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `••••…${key.slice(-4)}`;
}

function integrationsState() {
  const cloudUrl = process.env.CLOUDINARY_URL ?? "";
  const creds = parseCloudinaryUrl(cloudUrl);
  const sbUrl = process.env.SUPABASE_URL ?? config.supabaseUrl;
  const sbKey = process.env.SUPABASE_SERVICE_KEY ?? "";
  return {
    supabase: {
      configured: hasSupabase(),
      backend: store.backend,
      url: sbUrl || null,
      hasKey: Boolean(sbKey),
      keyHint: maskKey(sbKey),
      schema: config.supabaseSchema,
      schemaStatus: hasSupabase() ? (getSchemaStatus() ?? { ok: null as boolean | null, missing: [] as string[] }) : null,
    },
    cloudinary: {
      configured: Boolean(creds),
      cloudName: creds?.cloud ?? null,
      folder: process.env.CLOUDINARY_FOLDER || cloudinaryStatus().folder,
      hasUrl: Boolean(cloudUrl),
      urlHint: creds ? `cloudinary://***@${creds.cloud}` : null,
    },
  };
}

settingsRouter.get("/integrations", requireAuth, (_req, res) => {
  try {
    res.json(integrationsState());
  } catch (error) {
    handleError(res, error, "state");
  }
});

// --- Cloudinary -----------------------------------------------------------
const CloudinarySchema = z.object({
  // `cloudinary://<api_key>:<api_secret>@<cloud_name>` (se recortan espacios).
  // Vacío = borrar la configuración.
  url: z.string().max(500).optional().default(""),
});

settingsRouter.put("/cloudinary", requireAuth, async (req, res) => {
  if (!requireOwner(res)) return;
  const parsed = CloudinarySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Payload inválido", issues: parsed.error.issues });
  const url = parsed.data.url.trim();
  try {
    if (url && !parseCloudinaryUrl(url)) {
      return res.status(400).json({ error: "CLOUDINARY_URL no válida: se esperaba cloudinary://<api_key>:<api_secret>@<cloud_name>" });
    }
    applyRuntimeEnv({ CLOUDINARY_URL: url });
    upsertEnvFile({ CLOUDINARY_URL: url });
    console.log(`[settings] CLOUDINARY_URL ${url ? "actualizada" : "borrada"} por ${res.locals.userId ?? "owner"}`);
    res.json({ ok: true, ...integrationsState().cloudinary });
  } catch (error) {
    handleError(res, error, "save-cloudinary");
  }
});

const CloudinaryTestSchema = z.object({ url: z.string().max(500).optional() });

settingsRouter.post("/cloudinary/test", requireAuth, async (req, res) => {
  if (!requireOwner(res)) return;
  const parsed = CloudinaryTestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Payload inválido", issues: parsed.error.issues });
  const raw = (parsed.data.url ?? process.env.CLOUDINARY_URL ?? "").trim();
  const creds = parseCloudinaryUrl(raw);
  if (!creds) {
    return res.status(400).json({ ok: false, error: "CLOUDINARY_URL no válida o vacía: cloudinary://<api_key>:<api_secret>@<cloud_name>" });
  }
  try {
    // Llamada autenticada real (Admin API): 401 = credenciales malas.
    const auth = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString("base64");
    const response = await fetch(`https://api.cloudinary.com/v1_1/${creds.cloud}/usage`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403) {
      return res.status(200).json({ ok: false, error: "Cloudinary rechazó las credenciales (revisa api_key/api_secret/cloud_name)" });
    }
    if (!response.ok) {
      return res.status(200).json({ ok: false, error: `Cloudinary respondió HTTP ${response.status}` });
    }
    const usage = await cloudinaryUsage(creds);
    return res.json({ ok: true, cloud: creds.cloud, plan: usage.plan, storageUsedBytes: usage.storageUsedBytes, storageLimitBytes: usage.storageLimitBytes });
  } catch (error) {
    return res.status(200).json({ ok: false, error: error instanceof Error ? error.message : "No se pudo contactar con Cloudinary" });
  }
});

// --- Supabase -------------------------------------------------------------
const SupabaseSchema = z.object({
  url: z.string().trim().max(300).optional(),
  // service_role (sb_secret_… o eyJ…). Vacío = no tocar (o borrar si `clearKey`).
  serviceKey: z.string().max(2000).optional(),
  clearKey: z.boolean().optional(),
});

settingsRouter.put("/supabase", requireAuth, async (req, res) => {
  if (!requireOwner(res)) return;
  const parsed = SupabaseSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Payload inválido", issues: parsed.error.issues });
  try {
    const vars: Record<string, string> = {};
    const fileVars: Record<string, string> = {};
    if (parsed.data.url !== undefined) {
      const url = parsed.data.url.trim().replace(/\/rest\/v1.*$/, "").replace(/\/$/, "");
      if (url && !/^https:\/\/[A-Za-z0-9.-]+\.supabase\.co$|^https?:\/\/localhost(:\d+)?$|^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(url)) {
        return res.status(400).json({ error: "SUPABASE_URL no válida: usa la base del proyecto (https://xxxx.supabase.co)" });
      }
      vars.SUPABASE_URL = url;
      fileVars.SUPABASE_URL = url;
    }
    if (parsed.data.clearKey) {
      vars.SUPABASE_SERVICE_KEY = "";
      fileVars.SUPABASE_SERVICE_KEY = "";
    } else if (parsed.data.serviceKey !== undefined && parsed.data.serviceKey !== "") {
      const key = parsed.data.serviceKey.trim();
      if (key.length < 20) return res.status(400).json({ error: "SUPABASE_SERVICE_KEY demasiado corta: pega la service_role (Settings → API)" });
      vars.SUPABASE_SERVICE_KEY = key;
      fileVars.SUPABASE_SERVICE_KEY = key;
    }
    if (Object.keys(vars).length === 0) {
      return res.status(400).json({ error: "Nada que guardar: envía `url`, `serviceKey` o `clearKey`" });
    }
    applyRuntimeEnv(vars);
    resetSupabaseClient();
    upsertEnvFile(fileVars);
    // re-verifica el esquema con las nuevas credenciales (no bloquea si falla)
    let schema = null as { ok: boolean; missing: string[] } | null;
    if (hasSupabase()) {
      try {
        const status = await verifySchema(true);
        schema = { ok: status.ok, missing: status.missing };
      } catch {
        schema = null;
      }
    }
    console.log(`[settings] Supabase ${hasSupabase() ? "configurado" : "sin key"} por ${res.locals.userId ?? "owner"}`);
    res.json({ ok: true, ...integrationsState().supabase, verified: schema });
  } catch (error) {
    handleError(res, error, "save-supabase");
  }
});

const SupabaseTestSchema = z.object({
  url: z.string().trim().max(300).optional(),
  serviceKey: z.string().max(2000).optional(),
});

settingsRouter.post("/supabase/test", requireAuth, async (req, res) => {
  if (!requireOwner(res)) return;
  const parsed = SupabaseTestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Payload inválido", issues: parsed.error.issues });
  const url = (parsed.data.url ?? process.env.SUPABASE_URL ?? "").trim();
  const key = (parsed.data.serviceKey ?? process.env.SUPABASE_SERVICE_KEY ?? "").trim();
  if (!url || !key) {
    return res.status(200).json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY" });
  }
  try {
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const missing: string[] = [];
    for (const table of ["users", "cameras", "api_keys", "events"] as const) {
      const { error } = await client.from(table).select("*").limit(1);
      if (error && /Could not find the table|does not exist|PGRST205/i.test(error.message)) missing.push(table);
      else if (error && /Invalid API key|JWT|unauthorized|401/i.test(error.message)) {
        return res.status(200).json({ ok: false, error: "Supabase rechazó la key (¿pegaste la service_role y no la anon?)" });
      } else if (error && /Failed to fetch|fetch failed|ENOTFOUND|EAI_AGAIN/i.test(error.message)) {
        return res.status(200).json({ ok: false, error: `No se pudo contactar con ${url}: revisa la URL` });
      }
    }
    if (missing.length > 0) {
      return res.json({ ok: true, warning: `Conecta pero faltan tablas: ${missing.join(", ")} (ejecuta supabase/migrations/0001_init.sql)`, missing });
    }
    return res.json({ ok: true, message: "Supabase OK: conexión y esquema correctos" });
  } catch (error) {
    return res.status(200).json({ ok: false, error: error instanceof Error ? error.message : "Fallo la comprobación" });
  }
});
