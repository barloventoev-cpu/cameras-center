import { config as loadDotenv } from "dotenv";
import { findUpEnvFile } from "@cameras/core";

// Carga el `.env` de la raíz del monorepo, esté donde esté el cwd.
const envFile = findUpEnvFile(process.cwd());
if (envFile) loadDotenv({ path: envFile });

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const nodeEnv = process.env.NODE_ENV ?? "development";

export const config = {
  nodeEnv,
  isProd: nodeEnv === "production",
  port: toInt(process.env.PORT, 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  version: "0.1.0",
  /** F2: credenciales Supabase (se re-sincronizan con applyRuntimeEnv). */
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseKey: process.env.SUPABASE_SERVICE_KEY ?? "",
  supabaseSchema: process.env.SUPABASE_SCHEMA ?? "public",
  /** Secreto para firmar JWT (HS256) */
  jwtSecret: process.env.JWT_SECRET ?? "",
  /** false => sólo se puede registrar el primer usuario */
  allowRegister: process.env.ALLOW_REGISTER !== "false",
  /** Semilla de ejemplo para probar la UI sin cámaras reales */
  seedDemo: process.env.SEED_DEMO === "true",
  /** Token que debe presentar el agent en /api/agent/* y en el WS */
  agentToken: process.env.AGENT_TOKEN ?? "",
};

/** ¿Hay credenciales Supabase utilizables ahora mismo? (lee process.env en vivo
 *  para que la sección de Configuración pueda activarlo sin reiniciar). */
export function hasSupabase(): boolean {
  const url = process.env.SUPABASE_URL ?? config.supabaseUrl;
  const key = process.env.SUPABASE_SERVICE_KEY ?? config.supabaseKey;
  return Boolean(url && key);
}

/** Re-sincroniza `config` con `process.env` tras guardar desde la UI. */
export function refreshRuntimeConfig(): void {
  config.supabaseUrl = process.env.SUPABASE_URL ?? "";
  config.supabaseKey = process.env.SUPABASE_SERVICE_KEY ?? "";
  config.supabaseSchema = process.env.SUPABASE_SCHEMA ?? "public";
}

/** Aplica variables en memoria + `config` (el guardado en `.env` lo hace settings). */
export function applyRuntimeEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  refreshRuntimeConfig();
}
