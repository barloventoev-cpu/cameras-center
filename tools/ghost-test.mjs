#!/usr/bin/env node
/**
 * Prueba de humo: "imagen fantasma" (agent apagado, la tarjeta dice «En vivo»).
 *
 * Levanta el server compilado en un puerto aislado (almacén en memoria, sin
 * Supabase ni Cloudinary), simula un agent que manda UN frame y comprueba:
 *
 *   1. con frame fresco: el MJPEG sí sirve y el viewer SÍ recibe la "puesta al día";
 *   2. con el frame viejo (>15 s, agent apagado):
 *        - el MJPEG NO reenvía la foto caducada;
 *        - el viewer NO recibe nada al suscribirse (antes llegaba y la UI
 *          pintaba la imagen fantasma con la pastilla «En vivo»);
 *   3. al volver a llegar frames en vivo, todo vuelve a funcionar.
 */
import { spawn } from "node:child_process";
import { io } from "socket.io-client";
import { SignJWT } from "jose";

const PORT = 4399;
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET = "aa".repeat(32); // 64 hex → 32 bytes
const FRESH_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let failures = 0;
const check = (ok, label) => {
  results.push(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

// JPEG mínimo válido (1x1) para que el <img> del navegador lo acepte.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy" +
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA" +
    "AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEB" +
    "AQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//E" +
    "ABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAI" +
    "AQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAA" +
    "AAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
  "base64",
);

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return r.json();
    } catch {
      // server aún arrancando
    }
    await sleep(300);
  }
  throw new Error("el server no contestó a /api/health");
}

/** Lee el stream MJPEG durante `ms` y devuelve los bytes recibidos. */
async function readMjpeg(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const started = Date.now();
  let bytes = 0;
  let status = 0;
  let error = "";
  try {
    const res = await fetch(`${BASE}/api/v1/streams/${cameraId}.mjpg`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    status = res.status;
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    }
  } catch (e) {
    // abort esperado al terminar la ventana de lectura
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  return { status, bytes, error, ms: Date.now() - started };
}

/** Suscripción de viewer: devuelve los headers de los frames recibidos en `ms`. */
function watchFrames(ms) {
  const socket = io(BASE, { transports: ["websocket"], auth: { token } });
  const headers = [];
  return new Promise((resolve) => {
    const done = () => {
      socket.emit("viewer:unsubscribe", { type: "viewer:unsubscribe", cameraId });
      socket.close();
      resolve(headers);
    };
    const timer = setTimeout(done, ms);
    socket.on("connect", () => {
      socket.emit("viewer:subscribe", { type: "viewer:subscribe", cameraId }, () => undefined);
    });
    socket.on("stream:frame", (header) => {
      headers.push(header);
      clearTimeout(timer);
      done();
    });
    socket.on("connect_error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

function pushFrame(agent, seq) {
  agent.emit("stream:frame", { cameraId, seq, ts: Date.now(), encoding: "mjpeg", keyframe: true }, JPEG);
}

// --- arranque del server (sin Supabase: almacén en memoria) -----------------
const child = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "development",
    CORS_ORIGIN: "http://localhost:5173",
    SUPABASE_URL: "",
    SUPABASE_SERVICE_KEY: "",
    JWT_SECRET,
    AGENT_TOKEN: "",
    SEED_DEMO: "false",
    ALLOW_REGISTER: "true",
    CLOUDINARY_URL: "",
    RETENTION_ENABLED: "false",
    RATE_LIMIT_RPM: "1000",
    AUTH_RATE_LIMIT_RPM: "1000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d.toString()));
child.stderr.on("data", (d) => (serverLog += d.toString()));

let token = "";
let cameraId = "";

try {
  const health = await waitForHealth();
  check(health.status === "ok", "server arranca y responde /api/health");

  token = await new SignJWT({ email: "ghost@test", role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("00000000-0000-4000-8000-000000000001")
    .setIssuedAt()
    .setIssuer("cameras-center")
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET));

  const created = await fetch(`${BASE}/api/v1/cameras`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "Ghost", sourceType: "test", connection: "test://ghost" }),
  }).then((r) => r.json());
  cameraId = created.camera?.id;
  check(Boolean(cameraId), "cámara creada en el almacén en memoria");
  if (!cameraId) throw new Error("sin cámara de prueba");

  const agent = io(BASE, { transports: ["websocket"], auth: { token: "" } });
  await new Promise((res, rej) => {
    agent.on("connect", res);
    agent.on("connect_error", rej);
  });
  agent.emit("agent:hello", { agentId: "ghost-agent" });

  // --- 1. frame fresco: todo funciona --------------------------------------
  pushFrame(agent, 1);
  await sleep(500);

  const freshMjpeg = await readMjpeg(4000);
  check(freshMjpeg.status === 200 && freshMjpeg.bytes > 0, `MJPEG con frame fresco sirve imagen (${freshMjpeg.bytes} B)`);

  const freshViewer = await watchFrames(4000);
  check(
    freshViewer.length > 0 && freshViewer.some((h) => h.seq === -1),
    `viewer suscrito recibe la puesta al día (seq=${freshViewer.map((h) => h.seq).join(",") || "ninguno"})`,
  );

  // --- 2. el agent "se apaga": el frame envejece ----------------------------
  console.log(`   … esperando ${FRESH_MS / 1000} s a que el frame caduce`);
  await sleep(FRESH_MS + 1000);

  const t0 = Date.now();
  const alive = await fetch(`${BASE}/api/health`);
  check(alive.ok, `el server sigue vivo antes del MJPEG caducado (status=${alive.status} en ${Date.now() - t0} ms)`);

  const staleMjpeg = await readMjpeg(25_000);
  check(
    staleMjpeg.status === 503 && staleMjpeg.bytes < 500,
    `MJPEG sin señal contesta 503 y NO reenvía la foto caducada (status=${staleMjpeg.status} bytes=${staleMjpeg.bytes} en ${staleMjpeg.ms} ms ${staleMjpeg.error})`,
  );

  const staleViewer = await watchFrames(4000);
  check(staleViewer.length === 0, `viewer suscrito NO recibe la imagen fantasma (${staleViewer.length} frames)`);

  // --- 3. vuelve la señal en vivo ------------------------------------------
  pushFrame(agent, 2);
  await sleep(300);
  const backViewer = await watchFrames(4000);
  check(backViewer.length > 0, `al volver los frames, el viewer recibe señal (${backViewer.length} frames)`);

  const backMjpeg = await readMjpeg(4000);
  check(backMjpeg.bytes > 0, `al volver los frames, el MJPEG sirve imagen (${backMjpeg.bytes} B)`);

  agent.close();
} catch (error) {
  check(false, `ejecución: ${error instanceof Error ? error.message : error}`);
  console.error("\n--- log del server ---\n" + serverLog.slice(-4000));
} finally {
  child.kill();
}

if (failures > 0) console.error("\n--- log del server ---\n" + serverLog.slice(-3000));

console.log("\n" + results.join("\n"));
console.log(`\n${failures === 0 ? "TODO OK" : `${failures} fallo(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
