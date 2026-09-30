#!/usr/bin/env tsx
/**
 * F7 — auto-prueba de la grabación de clips por eventos.
 *
 *   npm run test:f7
 *
 * A) Lado agent: graba un clip REAL con FFmpeg sobre `testsrc`, comprueba que
 *    el MP4 es válido, lo sube a Cloudinary y verifica que se puede borrar.
 * B) Lado server: un "agent" falso (WebSocket) y se comprueba que
 *    1. el clip se pega al aviso de movimiento reciente (payload.clip)
 *    2. un viewer con JWT NO puede inyectar clips (sólo el agent)
 *    3. `POST /api/v1/cameras/:id/clip` pide la grabación (401/400/404/202) y
 *       el agent recibe `server:recordClip`
 *    4. sin aviso reciente se crea un evento `type=clip`, que el webhook
 *       recibe con la URL del clip
 *    5. la documentación (OpenAPI + /api/docs) cubre el endpoint
 *    6. limpieza: borra cámaras, eventos, webhook y el clip de Cloudinary
 *
 * Requiere: server en localhost:4000, TEST_EMAIL/TEST_PASSWORD, AGENT_TOKEN y
 * CLOUDINARY_URL en .env (y FFmpeg en el PATH para la parte A).
 */
import { io } from "socket.io-client";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteAsset, parseCloudinaryUrl, uploadVideo } from "@cameras/core";
import type { AgentClipReady } from "@cameras/protocol";
import type { AgentCamera } from "../apps/agent/src/pipeline/registry";

const BASE = "http://localhost:4000";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envText = readFileSync(join(root, ".env"), "utf8");
const val = (name: string) => (envText.match(new RegExp(`^${name}=(.*)$`, "m")) ?? [])[1]?.trim() ?? "";

const results: string[] = [];
let failures = 0;
const check = (ok: boolean, label: string, extra = ""): void => {
  results.push(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const info = (label: string) => results.push(`INFO  ${label}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const email = process.env.TEST_EMAIL || val("TEST_EMAIL");
const password = process.env.TEST_PASSWORD || val("TEST_PASSWORD");
const agentToken = process.env.AGENT_TOKEN || val("AGENT_TOKEN");
if (!email || !password) {
  console.error("Faltan TEST_EMAIL y TEST_PASSWORD en .env");
  process.exit(2);
}

// La carpeta de datos del agent apunta a un temporal de esta prueba para no
// mezclar sus MP4 con los del agent real. Hay que fijarla ANTES de importar
// clip.ts (config.ts la lee al cargarse), de ahí el import dinámico.
const dataDir = join(root, "artifacts", "f7-data");
mkdirSync(dataDir, { recursive: true });
process.env.AGENT_DATA_DIR = dataDir;
process.env.CLOUDINARY_URL = process.env.CLOUDINARY_URL || val("CLOUDINARY_URL");

const { ClipManager, buildClipArgs } = await import("../apps/agent/src/clip");

const creds = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
info(`Cloudinary: ${creds ? creds.cloud : "SIN CLOUDINARY_URL (la parte A fallará)"}`);

// ---------------------------------------------------------------------------
// 0. utilidades de red
// ---------------------------------------------------------------------------
type Json = Record<string, unknown>;

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE}${path}`, { headers });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json };
}

async function send(
  path: string,
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json };
}

async function until<T>(fn: () => Promise<T | null | undefined>, attempts = 30, ms = 300): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(ms);
  }
  return null;
}

/** MP4 mínimo para las subidas de prueba (se genera con FFmpeg en el paso 1). */
let testBuffer: Buffer | null = null;
const uploads: Array<{ publicId: string; url: string }> = [];

async function upload(buffer: Buffer, publicId: string): Promise<string> {
  if (!creds) throw new Error("sin CLOUDINARY_URL");
  const result = await uploadVideo(buffer, creds, { folder: "cameras-center/clips", publicId });
  uploads.push({ publicId: result.publicId, url: result.url });
  return result.url;
}

const cleanupFns: Array<() => Promise<void> | void> = [];

/** Borra lo que ha creado esta prueba (cámaras, eventos, webhook, disco). */
async function runCleanup(): Promise<void> {
  for (const fn of cleanupFns.reverse()) {
    try {
      await fn();
    } catch {
      // la limpieza nunca debe enmascarar el resultado
    }
  }
  cleanupFns.length = 0;
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // ...
  }
}

process.on("exit", () => {
  // la carpeta temporal se borra incluso en salidas tempranas (síncrono)
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // ...
  }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void runCleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

// ===========================================================================
// A. lado agent: grabar, validar el MP4 y subirlo
// ===========================================================================
console.log("\n[f7] A. construcción de argumentos");

const rtspSpec = { cameraId: "x", sourceType: "rtsp" as const, connection: "rtsp://user:pass@cam/av0_0" };
const rtspArgs = buildClipArgs(rtspSpec, join(dataDir, "a.mp4"), 5000);
const rtspLine = rtspArgs.join(" ");
check(rtspLine.includes("-c:v copy"), "RTSP se copia sin recodificar");
check(rtspLine.includes("-t 5"), "la duración va con -t (el proceso se muere solo)", rtspArgs[rtspArgs.indexOf("-t") + 1]);
check(rtspLine.includes("+frag_keyframe+empty_moov"), "MP4 fragmentado (reproducible aunque se corte)");
check(rtspLine.includes("-rtsp_transport tcp"), "el RTSP va por TCP");
check(rtspArgs[rtspArgs.length - 1] === join(dataDir, "a.mp4"), "el archivo de salida va al final");
check(rtspArgs.includes("-y"), "sobrescribe sin preguntar");
check(!rtspLine.includes("-vf"), "no transcodifica (sin filtros)");

const testArgs = buildClipArgs(
  { cameraId: "y", sourceType: "test", connection: "test://y" },
  join(dataDir, "b.mp4"),
  3000,
);
check(testArgs.join(" ").includes("libx264"), "las fuentes sin H.264 se recodifican");
check(!testArgs.join(" ").includes("-c:v copy"), "…por tanto no se copian");
check(
  buildClipArgs(rtspSpec, join(dataDir, "c.mp4"), 400).join(" ").includes("-t 1"),
  "la duración mínima es 1 s",
);

console.log("\n[f7] B. grabación real con FFmpeg + subida");

const clips = new ClipManager();
const sent: AgentClipReady[] = [];
clips.setEmitter((message) => {
  sent.push(message);
  return true;
});
clips.sync([
  {
    id: "f7-selftest",
    name: "f7-selftest",
    sourceType: "test",
    active: true,
    connection: "test://f7",
  } as unknown as AgentCamera,
]);

check(clips.record("f7-selftest", "manual", 3000), "grabación de 3 s iniciada");
check(!clips.record("f7-selftest", "manual", 3000), "una segunda grabación simultánea se ignora");

const clip = await until(async () => sent[0] ?? null, 40, 500);
check(Boolean(clip), "agent:clipReady emitido tras subir el MP4", `${sent.length} mensajes`);

const clipDir = join(dataDir, "clips", "f7-selftest");
const localFiles = existsSync(clipDir) ? readdirSync(clipDir) : [];
info(`archivos locales: ${localFiles.length ? localFiles.join(", ") : "ninguno"}`);
const localFile = localFiles[0] ? join(clipDir, localFiles[0]) : null;

if (clip) {
  testBuffer = localFile && existsSync(localFile) ? readFileSync(localFile) : null;
  check(Boolean(testBuffer), "el MP4 existe en disco (grabación local)", `${testBuffer?.length ?? 0} B`);
  if (testBuffer) {
    const head = testBuffer.subarray(0, 16).toString("latin1");
    check(head.includes("ftyp"), "empieza por el box `ftyp`", head.replace(/[^\x20-\x7e]/g, "."));
    check(
      testBuffer.includes("moof") || testBuffer.includes("mdat"),
      "trae datos de vídeo (moof/mdat)",
      `${testBuffer.length} B`,
    );
    check(clip.bytes === testBuffer.length, "los bytes informados coinciden con el archivo", `${clip.bytes} vs ${testBuffer.length}`);
  }
  check(clip.url.startsWith("https://res.cloudinary.com/"), "subido a Cloudinary", clip.url.slice(0, 64));
  check(clip.durationMs === 3000, "informa la duración pedida", `${clip.durationMs} ms`);
  check(clip.trigger === "manual", "trigger = manual", clip.trigger);
  check(clip.cameraId === "f7-selftest", "informa la cámara", clip.cameraId);

  const head = await fetch(clip.url, { method: "HEAD" }).catch(() => null);
  check(head?.status === 200, `el clip se descarga → ${head?.status ?? "sin respuesta"}`);
  const type = head?.headers.get("content-type") ?? "";
  check(type.includes("video"), "es un vídeo", type || "sin content-type");

  const status = clips.status();
  check(
    status.recorded === 1 && status.uploaded === 1 && status.failures === 0,
    "estadísticas del ClipManager",
    `recorded=${status.recorded} uploaded=${status.uploaded} failures=${status.failures}`,
  );
  check(status.active.length === 0, "no queda ninguna grabación en marcha");
}

// ---------------------------------------------------------------------------
// segundo clip (con otro public_id): es el que usará la parte de servidor para
// probar la ruta manual sin pisar la URL del primero
// ---------------------------------------------------------------------------
let secondUrl = "";
try {
  if (testBuffer) secondUrl = await upload(testBuffer, "f7-selftest-b");
  info(`segundo clip de prueba: ${secondUrl.slice(0, 64)}`);
} catch (error) {
  info(`no se pudo generar el segundo clip: ${error instanceof Error ? error.message : error}`);
}

// ===========================================================================
// C. lado servidor
// ===========================================================================
console.log("\n[f7] C. servidor: login, cámaras y webhook");

const login = await send("/api/auth/login", "POST", { email, password });
const token = String(login.body.token ?? "");
check(Boolean(token), "login → JWT");
if (!token) {
  console.log(results.join("\n"));
  process.exit(1);
}
const auth = { authorization: `Bearer ${token}` };

const cameras = await get("/api/v1/cameras");
const baseCamera = (cameras.body.cameras as Array<{ id: string; name: string }> | undefined)?.[0];
check(Boolean(baseCamera), `cámara registrada (${(cameras.body.cameras as unknown[] | undefined)?.length ?? 0})`);
if (!baseCamera) {
  console.log(results.join("\n"));
  process.exit(1);
}

/** Cámara de movimiento (recibe el aviso y el clip que se le pega). */
async function createCamera(name: string): Promise<string | null> {
  const created = await send("/api/v1/cameras", "POST", {
    name,
    sourceType: "test",
    connection: `test://${name}`,
    // inactiva a propósito: el agent REAL la ignora y sólo responde el falso
    active: false,
  }, auth);
  const camera = created.body.camera as { id?: string } | undefined;
  return camera?.id ?? null;
}

const camA = await createCamera("f7-motion");
const camB = await createCamera("f7-manual");
check(Boolean(camA), "cámara de prueba A creada", String(camA));
check(Boolean(camB), "cámara de prueba B creada", String(camB));
if (camA) cleanupFns.push(async () => void (await send(`/api/v1/cameras/${camA}`, "DELETE", undefined, auth)));
if (camB) cleanupFns.push(async () => void (await send(`/api/v1/cameras/${camB}`, "DELETE", undefined, auth)));

// webhook receptor local
const hooks: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
const hookServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    hooks.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(204).end();
  });
});
await new Promise<void>((done) => hookServer.listen(0, "127.0.0.1", () => done()));
const hookPort = (hookServer.address() as { port: number }).port;
const HOOK_URL = `http://127.0.0.1:${hookPort}/clips`;
cleanupFns.push(() => {
  hookServer.close();
});

const createdHook = await send("/api/v1/webhooks", "POST", { url: HOOK_URL, events: ["motion", "clip"] }, auth);
const hookId = String((createdHook.body.webhook as { id?: string } | undefined)?.id ?? "");
check(createdHook.status === 201 && Boolean(hookId), `webhook registrado → ${createdHook.status}`);
if (hookId) cleanupFns.push(async () => void (await send(`/api/v1/webhooks/${hookId}`, "DELETE", undefined, auth)));

// --- permisos de la nueva ruta ---------------------------------------------
const noAuth = await send(`/api/v1/cameras/${camA ?? baseCamera.id}/clip`, "POST", {});
check(noAuth.status === 401, `POST /clip sin credencial → ${noAuth.status}`);

const badDuration = await send(`/api/v1/cameras/${camA ?? baseCamera.id}/clip`, "POST", { durationMs: 100 }, auth);
check(badDuration.status === 400, `durationMs fuera de rango → ${badDuration.status}`);

const missing = await send("/api/v1/cameras/00000000-0000-4000-8000-000000000000/clip", "POST", {}, auth);
check(missing.status === 404, `cámara inexistente → ${missing.status}`);

// --- sockets: espectador (JWT) y agent falso --------------------------------
const viewer = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token } });
const liveEvents: Array<{ type: string; event: { id?: string; clip?: string | null; type?: string } }> = [];
viewer.on("event:new", (payload) => liveEvents.push(payload));
await new Promise<void>((done) => {
  viewer.on("connect", () => done());
  viewer.on("connect_error", () => done());
  setTimeout(() => done(), 4000);
});
check(viewer.connected, "WS del espectador conectado");

const fake = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token: agentToken } });
const recordRequests: Array<{ cameraId?: string; durationMs?: number }> = [];
fake.on("server:recordClip", (payload) => recordRequests.push(payload ?? {}));
await new Promise<void>((done) => {
  fake.on("connect", () => done());
  fake.on("connect_error", () => done());
  setTimeout(() => done(), 4000);
});
check(fake.connected, "WS conectado como agent", fake.connected ? "" : "¿AGENT_TOKEN?");
if (fake.connected) {
  fake.emit("agent:hello", {
    type: "agent:hello",
    agentId: "f7-test",
    version: "0.1.0",
    cameras: [],
    capabilities: ["record", "motion"],
  });
  await sleep(300);
}

const health0 = (await get("/api/health")).body.clips as Json | undefined;
const received0 = Number(health0?.received ?? 0);
const attached0 = Number(health0?.attached ?? 0);
const created0 = Number(health0?.created ?? 0);

// --- un viewer NO puede colar clips -----------------------------------------
if (viewer.connected) {
  viewer.emit("agent:clipReady", {
    type: "agent:clipReady",
    cameraId: camA ?? baseCamera.id,
    url: "https://res.cloudinary.com/demo/video/upload/spoof.mp4",
    durationMs: 1000,
    bytes: 1234,
    at: Date.now(),
    trigger: "manual",
  });
}
await sleep(1200);
const healthSpoof = (await get("/api/health")).body.clips as Json | undefined;
check(
  Number(healthSpoof?.received ?? 0) === received0,
  "un viewer con JWT no puede inyectar clips",
  `received ${received0} → ${healthSpoof?.received}`,
);

// ===========================================================================
// D. aviso de movimiento + clip que se le pega
// ===========================================================================
console.log("\n[f7] D. el clip se pega al aviso reciente");

if (!camA || !clip) {
  info("sin cámara A o sin clip: se salta la parte D");
} else {
  let sentEvent = false;
  if (fake.connected) {
    fake.emit("agent:event", {
      type: "agent:event",
      cameraId: camA,
      event: "motion",
      score: 0.37,
      at: Date.now(),
    });
    sentEvent = true;
  }
  check(sentEvent, "agent:event enviado");

  const motion = await until(async () => {
    const list = await get(`/api/v1/events?type=motion&cameraId=${camA}&limit=5`, auth);
    const rows = (list.body.events as Array<{ id: string; clip: string | null; score: number | null; snapshot: string | null }>) ?? [];
    return rows[0] ?? null;
  });
  check(Boolean(motion), "el aviso de movimiento queda registrado", String(motion?.id));
  if (motion) {
    check(motion.score === 0.37, "conserva la puntuación", String(motion.score));
    check(motion.clip === null, "todavía sin clip", String(motion.clip));
  }

  if (motion && fake.connected) {
    fake.emit("agent:clipReady", {
      type: "agent:clipReady",
      cameraId: camA,
      url: clip.url,
      durationMs: clip.durationMs,
      bytes: clip.bytes,
      at: Date.now() - 3000,
      trigger: "motion",
    });

    const withClip = await until(async () => {
      const list = await get(`/api/v1/events?type=motion&cameraId=${camA}&limit=5`, auth);
      const rows = (list.body.events as Array<{ id: string; clip: string | null }>) ?? [];
      return rows.find((row) => row.clip === clip.url) ?? null;
    });
    check(Boolean(withClip), "el clip queda enlazado en el aviso", String(withClip?.clip ?? "").slice(0, 48));

    const live = await until(async () =>
      liveEvents.find((entry) => entry.event?.clip === clip.url) ?? null,
    );
    check(Boolean(live), "el espectador recibe `event:new` con el clip", `${liveEvents.length} avisos`);

    // y el webhook del propio aviso NO llevaba clip (se emitió antes)
    await sleep(400);
    const motionHooks = hooks.filter((h) => String(h.headers["x-cameras-event"]) === "motion");
    check(motionHooks.length >= 1, "el aviso también se notificó por webhook", `${motionHooks.length}`);
    if (motionHooks[0]) {
      const body = JSON.parse(motionHooks[0].body) as { clip?: string };
      check(body.clip === undefined, "el aviso previo al clip no lo incluía", String(body.clip));
    }

    cleanupFns.push(async () => void (await send(`/api/v1/events/${motion.id}`, "DELETE", undefined, auth)));
  }
}

// ===========================================================================
// E. petición manual → server:recordClip → evento type=clip
// ===========================================================================
console.log("\n[f7] E. POST /cameras/:id/clip");

if (!camB || !secondUrl || !fake.connected) {
  info("sin cámara B, sin segundo clip o sin agent falso: se salta la parte E");
} else {
  const requested = await send(`/api/v1/cameras/${camB}/clip`, "POST", { durationMs: 1000 }, auth);
  check(requested.status === 202, `POST /clip → ${requested.status}`, JSON.stringify(requested.body).slice(0, 80));
  check(
    (requested.body.clip as { cameraId?: string } | undefined)?.cameraId === camB,
    "la respuesta identifica la cámara",
    String((requested.body.clip as { cameraId?: string } | undefined)?.cameraId),
  );

  const record = await until(async () => recordRequests.find((r) => r.cameraId === camB) ?? null, 20, 300);
  check(Boolean(record), "el agent recibe `server:recordClip`", `${recordRequests.length} peticiones`);
  if (record) check(record.durationMs === 1000, "…con la duración pedida", String(record.durationMs));

  if (record) {
    fake.emit("agent:clipReady", {
      type: "agent:clipReady",
      cameraId: camB,
      url: secondUrl,
      durationMs: 1000,
      bytes: 123456,
      at: Date.now(),
      trigger: "manual",
    });
  }

  const clipEvent = await until(async () => {
    const list = await get(`/api/v1/events?type=clip&cameraId=${camB}&limit=5`, auth);
    const rows = (list.body.events as Array<{ id: string; clip: string | null; type: string; score: number | null }>) ?? [];
    return rows.find((row) => row.clip === secondUrl) ?? null;
  });
  check(Boolean(clipEvent), "se crea un evento type=clip con el clip", String(clipEvent?.id ?? ""));
  if (clipEvent) {
    check(clipEvent.type === "clip", "type=clip", clipEvent.type);
    check(clipEvent.score === null, "sin puntuación (no es un aviso)", String(clipEvent.score));
    cleanupFns.push(async () => void (await send(`/api/v1/events/${clipEvent.id}`, "DELETE", undefined, auth)));

    const hook = await until(
      async () =>
        hooks.find((h) => {
          if (String(h.headers["x-cameras-event"]) !== "clip") return false;
          try {
            return (JSON.parse(h.body) as { clip?: string }).clip === secondUrl;
          } catch {
            return false;
          }
        }) ?? null,
      30,
      300,
    );
    check(Boolean(hook), "el webhook recibe el evento clip con su URL", `${hooks.length} POST`);
    if (hook) {
      const body = JSON.parse(hook.body) as { clip?: string; type?: string; source?: string };
      check(body.type === "clip", "payload type=clip", String(body.type));
      check(body.clip === secondUrl, "payload con la URL del clip", String(body.clip).slice(0, 48));
      check(body.source === "cameras-center", "payload identificado", String(body.source));
    }
  }
}

// ===========================================================================
// F. salud y documentación
// ===========================================================================
console.log("\n[f7] F. salud, agent local y docs");

const health = (await get("/api/health")).body.clips as Json | undefined;
check(Number(health?.received ?? 0) >= received0 + 2, "contadores: clips recibidos", `${received0} → ${health?.received}`);
check(Number(health?.attached ?? 0) >= attached0 + 1, "contadores: pegados a un aviso", `${attached0} → ${health?.attached}`);
check(Number(health?.created ?? 0) >= created0 + 1, "contadores: eventos type=clip", `${created0} → ${health?.created}`);
check(Number(health?.failures ?? 0) === 0, "sin fallos de clip", String(health?.failures));

try {
  const agentLocal = await fetch("http://localhost:4100/api/clips", { signal: AbortSignal.timeout(3000) });
  if (agentLocal.ok) {
    const body = (await agentLocal.json()) as { clips?: { recorded?: number; active?: unknown[] } };
    check(Array.isArray(body.clips?.active), "GET :4100/api/clips responde", `recorded=${body.clips?.recorded}`);
  } else {
    info(`agent local en 4100 → HTTP ${agentLocal.status}`);
  }
} catch {
  info("agent local no disponible en :4100 (normal si no está corriendo)");
}

const openapi = (await get("/api/openapi.json")).body as {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, { properties?: Record<string, { enum?: string[] } & Json> }> };
};
check(Boolean(openapi.paths?.["/api/v1/cameras/{id}/clip"]?.post), "OpenAPI documenta POST /cameras/:id/clip");
const eventSchema = openapi.components?.schemas?.Event?.properties;
check(Boolean(eventSchema?.clip), "OpenAPI documenta el campo `clip`");
check(eventSchema?.type?.enum?.includes("clip") ?? false, "el enum de type incluye `clip`");

const docs = await fetch(`${BASE}/api/docs`).then((r) => r.text());
check(docs.includes("Clips (F7)"), "/api/docs explica los clips");

// ===========================================================================
// limpieza + resultado
// ===========================================================================
if (creds) {
  for (const asset of uploads) {
    try {
      const ok = await deleteAsset(creds, asset.publicId, 15000, "video");
      check(ok, `clip de prueba borrado de Cloudinary (${asset.publicId})`);
    } catch (error) {
      check(false, `clip de prueba borrado de Cloudinary (${asset.publicId})`, error instanceof Error ? error.message : String(error));
    }
  }
}

await runCleanup();
viewer.disconnect();
fake.disconnect();

console.log("");
for (const line of results) console.log(line);
console.log(`\n[f7] resultado: ${results.filter((l) => l.startsWith("OK")).length} ok, ${failures} fallos\n`);
if (failures > 0) process.exitCode = 1;
