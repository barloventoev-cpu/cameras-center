#!/usr/bin/env node
/**
 * npm run test:f6 — F6: detección de movimiento + snapshots + webhooks.
 *
 * Comprueba el recorrido completo del aviso (sin depender de que haya movimiento
 * real delante de la cámara): un "agent" falso manda `agent:event` por WebSocket
 * y se verifica que
 *   1. GET /api/v1/events exige JWT o API key con scope `read`
 *   2. los webhooks se gestionan con JWT de owner y el secreto se ve UNA vez
 *   3. el webhook recibe un POST firmado (HMAC-SHA256 verificado aquí mismo)
 *   4. la foto del evento sube a Cloudinary y `GET /events` la devuelve
 *   5. un espectador recibe el `event:new` en directo
 *   6. un viewer con JWT NO puede colar eventos (sólo el agent)
 *   7. un webhook caído suma `failures` y reintenta
 *   8. la documentación (OpenAPI + /api/docs) cubre los nuevos endpoints
 *   9. limpieza: borra eventos y webhooks creados por este test
 *
 * Requiere: server levantado, TEST_EMAIL/TEST_PASSWORD y AGENT_TOKEN en .env.
 */
import { io } from "socket.io-client";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "http://localhost:4000";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envText = readFileSync(resolve(root, ".env"), "utf8");
const val = (n) => (envText.match(new RegExp(`^${n}=(.*)$`, "m")) ?? [])[1]?.trim() ?? "";

const results = [];
let failures = 0;
const check = (ok, label, extra = "") => {
  results.push(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const info = (label) => results.push(`INFO  ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const email = process.env.TEST_EMAIL || val("TEST_EMAIL");
const password = process.env.TEST_PASSWORD || val("TEST_PASSWORD");
const agentToken = process.env.AGENT_TOKEN || val("AGENT_TOKEN");
if (!email || !password) {
  console.error("Faltan TEST_EMAIL y TEST_PASSWORD en .env");
  process.exit(2);
}

/** JPEG 1x1 válido: respaldo si el agent local no está sirviendo snapshots. */
const TINY_JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

// ---------------------------------------------------------------------------
// 0. webhook receptor local (recibe los POST que lanza el server)
// ---------------------------------------------------------------------------
const hooks = [];
const hookServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    hooks.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(204).end();
  });
});
await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
const HOOK_URL = `http://127.0.0.1:${hookServer.address().port}/cameras`;
info(`webhook receptor en ${HOOK_URL}`);

// ---------------------------------------------------------------------------
// 1. sesión
// ---------------------------------------------------------------------------
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
}).then((r) => r.json());
const token = login.token;
check(Boolean(token), "login → JWT");
if (!token) {
  hookServer.close();
  console.log(results.join("\n"));
  process.exit(1);
}
const auth = { authorization: `Bearer ${token}` };

const cameras = await fetch(`${BASE}/api/v1/cameras`).then((r) => r.json());
const camera = cameras.cameras?.[0];
check(Boolean(camera), `cámara registrada (${cameras.cameras?.length ?? 0})`);
if (!camera) {
  hookServer.close();
  console.log(results.join("\n"));
  process.exit(1);
}
const cameraId = camera.id;

// ---------------------------------------------------------------------------
// 2. los eventos exigen credencial de lectura
// ---------------------------------------------------------------------------
const eventsNoAuth = await fetch(`${BASE}/api/v1/events`);
check(eventsNoAuth.status === 401, `GET /events sin credencial → ${eventsNoAuth.status}`);

const eventsBadKey = await fetch(`${BASE}/api/v1/events`, { headers: { "x-api-key": `cc_live_${"a".repeat(40)}` } });
check(eventsBadKey.status === 401, `GET /events con key inexistente → ${eventsBadKey.status}`);

const eventsJwt = await fetch(`${BASE}/api/v1/events?limit=5`, { headers: auth });
const initialEvents = await eventsJwt.json().catch(() => ({}));
check(eventsJwt.status === 200, `GET /events con JWT → ${eventsJwt.status}`);
check(Array.isArray(initialEvents?.events), "la respuesta trae `events`", `${initialEvents?.events?.length ?? "?"} filas`);
check((initialEvents?.events ?? []).every((e) => e.type === "motion"), "por defecto sólo devuelve eventos de movimiento");

const badQuery = await fetch(`${BASE}/api/v1/events?limit=999`, { headers: auth });
check(badQuery.status === 400, `limit fuera de rango → ${badQuery.status}`);

// --- API key con scope read puede leer los eventos --------------------------
const keyRes = await fetch(`${BASE}/api/v1/keys`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ label: "f6-test", scopes: ["read"], rate_limit: 60 }),
});
const keyData = await keyRes.json().catch(() => ({}));
const apiKey = keyData.key;
check(keyRes.status === 201 && Boolean(apiKey), "API key de lectura creada");
const createdKeyId = keyData.apikey?.id;

const eventsWithKey = await fetch(`${BASE}/api/v1/events?limit=3`, { headers: { "x-api-key": apiKey } });
check(eventsWithKey.status === 200, `GET /events con API key → ${eventsWithKey.status}`);

const hookWithKey = await fetch(`${BASE}/api/v1/webhooks`, {
  method: "POST",
  headers: { "x-api-key": apiKey, "content-type": "application/json" },
  body: JSON.stringify({ url: HOOK_URL }),
});
check(hookWithKey.status === 401, `POST /webhooks con API key → ${hookWithKey.status} (escritura sólo JWT)`);

// ---------------------------------------------------------------------------
// 3. gestión de webhooks
// ---------------------------------------------------------------------------
const hookNoAuth = await fetch(`${BASE}/api/v1/webhooks`);
check(hookNoAuth.status === 401, `GET /webhooks sin token → ${hookNoAuth.status}`);

const badUrl = await fetch(`${BASE}/api/v1/webhooks`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ url: "ftp://no-valida" }),
});
check(badUrl.status === 400, `URL no http(s) → ${badUrl.status}`);

const hookRes = await fetch(`${BASE}/api/v1/webhooks`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ url: HOOK_URL, secret: "s3creto-f6-del-test" }),
});
const hookData = await hookRes.json().catch(() => ({}));
check(hookRes.status === 201, `POST /webhooks → ${hookRes.status}`);
check(hookData.secret === "s3creto-f6-del-test", "el secreto se devuelve al crearlo", hookData.secret ?? "");
check(Boolean(hookData.webhook?.id), "el webhook creado tiene id", hookData.webhook?.id ?? "");
const hookId = hookData.webhook?.id;
const SECRET = hookData.secret ?? "s3creto-f6-del-test";

// webhook "caído" para comprobar reintentos
const deadRes = await fetch(`${BASE}/api/v1/webhooks`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ url: "http://127.0.0.1:9/muerto" }),
});
const deadData = await deadRes.json().catch(() => ({}));
const deadId = deadData.webhook?.id;
check(deadRes.status === 201 && Boolean(deadId), "webhook contra un puerto cerrado creado");

const hookList = await fetch(`${BASE}/api/v1/webhooks`, { headers: auth }).then((r) => r.json());
check((hookList.webhooks ?? []).length >= 2, `GET /webhooks lista ${hookList.webhooks?.length ?? 0}`);
check(!JSON.stringify(hookList).includes("s3creto-f6-del-test"), "el listado NUNCA devuelve el secreto");
check(Boolean(hookList.stats), "las estadísticas acompañan a la lista", JSON.stringify(hookList.stats ?? {}).slice(0, 90));

// ---------------------------------------------------------------------------
// 4. sockets: espectador (JWT) que espera `event:new` + agent falso
// ---------------------------------------------------------------------------
const viewerSocket = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token } });
const liveEvents = [];
viewerSocket.on("event:new", (payload) => liveEvents.push(payload));
await new Promise((res) => {
  viewerSocket.on("connect", res);
  viewerSocket.on("connect_error", res);
  setTimeout(res, 4000);
});
check(viewerSocket.connected, "WS del espectador conectado");

const agentSocket = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token: agentToken } });
await new Promise((res) => {
  agentSocket.on("connect", res);
  agentSocket.on("connect_error", res);
  setTimeout(res, 4000);
});
check(agentSocket.connected, "WS conectado como agent", agentSocket.connected ? "" : "¿AGENT_TOKEN?");
if (agentSocket.connected) {
  agentSocket.emit("agent:hello", {
    type: "agent:hello",
    agentId: "f6-test",
    version: "0.1.0",
    cameras: [],
    capabilities: ["motion"],
  });
}

// espectador intenta meter un evento: debe ignorarse
const healthBefore = await fetch(`${BASE}/api/health`).then((r) => r.json());
const receivedBefore = healthBefore?.events?.received ?? 0;
if (viewerSocket.connected) {
  viewerSocket.emit("agent:event", {
    type: "agent:event",
    cameraId,
    event: "motion",
    score: 0.99,
    at: Date.now(),
    jpegBase64: TINY_JPEG,
  });
}
await sleep(1200);
const healthAfterSpoof = await fetch(`${BASE}/api/health`).then((r) => r.json());
check(
  (healthAfterSpoof?.events?.received ?? 0) === receivedBefore,
  "un viewer con JWT no puede inyectar eventos",
  `received ${receivedBefore} → ${healthAfterSpoof?.events?.received}`,
);

// ---------------------------------------------------------------------------
// 5. imagen del evento (snapshot del agent local o respaldo 1x1)
// ---------------------------------------------------------------------------
let jpegB64 = null;
try {
  const snap = await fetch(`http://localhost:4100/snapshot/${cameraId}.jpg`, { signal: AbortSignal.timeout(4000) });
  if (snap.ok) jpegB64 = Buffer.from(await snap.arrayBuffer()).toString("base64");
} catch {
  // el agent local no está corriendo: se usa el respaldo
}
if (!jpegB64) jpegB64 = TINY_JPEG;
info(`imagen del evento: ${jpegB64 === TINY_JPEG ? "JPEG 1x1 de respaldo (agent local caído)" : `${Math.round((jpegB64.length * 3) / 4)} bytes del agent`}`);

// ---------------------------------------------------------------------------
// 6. el agent manda el evento
// ---------------------------------------------------------------------------
const eventAt = Date.now();
function sendEvent(score, at = Date.now()) {
  if (!agentSocket.connected) return false;
  agentSocket.emit("agent:event", {
    type: "agent:event",
    cameraId,
    event: "motion",
    score,
    at,
    jpegBase64: jpegB64,
  });
  return true;
}

check(sendEvent(0.42, eventAt), "agent:event enviado por el WebSocket");

let hook = null;
for (let i = 0; i < 40 && !hook; i += 1) {
  hook = hooks.find((h) => h.method === "POST");
  if (!hook) await sleep(250);
}
check(Boolean(hook), "el webhook ha recibido un POST", `${hooks.length} recibidos`);

if (hook) {
  const body = JSON.parse(hook.body);
  check(hook.url === "/cameras", "llega a la ruta registrada", hook.url);
  check(hook.headers["x-cameras-event"] === "motion", "cabecera x-cameras-event", String(hook.headers["x-cameras-event"]));
  check(Boolean(hook.headers["x-cameras-delivery"]), "cabecera x-cameras-delivery", String(hook.headers["x-cameras-delivery"]));

  const ts = Number(hook.headers["x-cameras-timestamp"]);
  check(Number.isFinite(ts) && Math.abs(Math.floor(Date.now() / 1000) - ts) <= 300, "timestamp dentro de ±300 s", String(ts));

  const expected = `sha256=${createHmac("sha256", SECRET).update(`${ts}.${hook.body}`).digest("hex")}`;
  check(hook.headers["x-cameras-signature"] === expected, "firma HMAC-SHA256 verificada", String(hook.headers["x-cameras-signature"]).slice(0, 30) + "…");

  const wrong = `sha256=${createHmac("sha256", "otro-secreto").update(`${ts}.${hook.body}`).digest("hex")}`;
  check(hook.headers["x-cameras-signature"] !== wrong, "con otro secreto la firma no cuadra");

  check(body.type === "motion", "el payload es de tipo motion", String(body.type));
  check(body.camera?.id === cameraId, "el payload lleva la cámara", String(body.camera?.id));
  check(body.camera?.name === camera.name, "…con su nombre legible", String(body.camera?.name));
  check(body.score === 0.42, "el payload lleva la puntuación", String(body.score));
  check(body.at === eventAt, "el payload marca la época del aviso", String(body.at));
  check(body.source === "cameras-center", "el payload se identifica", String(body.source));
  check(typeof body.snapshot === "string" && body.snapshot.startsWith("https://res.cloudinary.com/"), "el payload enlaza la foto", String(body.snapshot).slice(0, 60));
}

// ---------------------------------------------------------------------------
// 7. el evento queda en la API con su foto
// ---------------------------------------------------------------------------
let storedId = hook ? JSON.parse(hook.body).id : null;
let stored = null;
for (let i = 0; i < 20 && !stored; i += 1) {
  const list = await fetch(`${BASE}/api/v1/events?limit=20`, { headers: auth }).then((r) => r.json());
  stored = (list.events ?? []).find((e) => e.id === storedId) ?? null;
  if (!stored) await sleep(300);
}
check(Boolean(stored), "el evento aparece en GET /api/v1/events", String(storedId));
if (stored) {
  check(stored.cameraName === camera.name, "la fila incluye el nombre de la cámara", String(stored.cameraName));
  check(stored.score === 0.42, "la fila conserva la puntuación", String(stored.score));
  check(typeof stored.snapshot === "string" && stored.snapshot.startsWith("https://res.cloudinary.com/"), "la fila conserva la URL de Cloudinary", String(stored.snapshot).slice(0, 50));

  const photo = await fetch(stored.snapshot);
  const type = photo.headers.get("content-type") ?? "";
  check(photo.status === 200, `la foto se descarga → ${photo.status}`);
  check(type.includes("image"), "es una imagen", type);
  const bytes = Buffer.from(await photo.arrayBuffer());
  check(bytes.length > 100 && bytes[0] === 0xff && bytes[1] === 0xd8, "y es un JPEG real", `${bytes.length} B`);

  const filtered = await fetch(`${BASE}/api/v1/events?cameraId=${cameraId}&limit=50`, { headers: auth }).then((r) => r.json());
  check((filtered.events ?? []).some((e) => e.id === storedId), "filtro por cameraId funciona");
}

// el espectador recibe el aviso en directo
let live = null;
for (let i = 0; i < 20 && !live; i += 1) {
  live = liveEvents.find((e) => e.event?.id === storedId) ?? null;
  if (!live) await sleep(250);
}
check(Boolean(live), "el espectador recibe `event:new` en directo", `${liveEvents.length} avisos`);
if (live?.event) check(live.event.cameraName === camera.name, "el aviso en directo lleva el nombre", String(live.event.cameraName));

// ---------------------------------------------------------------------------
// 8. webhook caído → reintenta y contabiliza fallos
// ---------------------------------------------------------------------------
check(sendEvent(0.5), "segundo agent:event (webhook caído en la lista)");
let failedWebhook = null;
for (let i = 0; i < 40 && !failedWebhook; i += 1) {
  const data = await fetch(`${BASE}/api/v1/webhooks`, { headers: auth }).then((r) => r.json());
  failedWebhook = (data.webhooks ?? []).find((w) => w.id === deadId) ?? null;
  if (!failedWebhook || failedWebhook.failures === 0) {
    failedWebhook = null;
    await sleep(400);
  }
}
check(Boolean(failedWebhook), "el webhook caído queda registrado como fallido", failedWebhook ? `último error: ${failedWebhook.lastError}` : "sin registro");
if (failedWebhook) check(failedWebhook.failures >= 1, "contabiliza `failures`", String(failedWebhook.failures));
if (failedWebhook) check(failedWebhook.lastError !== null, "guarda el último error", String(failedWebhook.lastError).slice(0, 60));

// ---------------------------------------------------------------------------
// 9. salud y documentación
// ---------------------------------------------------------------------------
let health = null;
for (let i = 0; i < 30 && !health; i += 1) {
  health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  // se espera a TODO lo que se va a afirmar (no basta con `persisted`: los
  // webhooks se entregan después de guardar y el envío caído tarda menos que
  // el exitoso, así que sin esta condición el test era una carrera)
  if (
    (health.events?.persisted ?? 0) >= 2 &&
    (health.webhooks?.failures ?? 0) >= 1 &&
    (health.webhooks?.deliveries ?? 0) >= 2
  ) {
    break;
  }
  health = null;
  await sleep(400);
}
check(Boolean(health), "GET /api/health responde");
check(Boolean(health?.events), "GET /api/health informa de `events`", JSON.stringify(health?.events ?? {}));
check((health?.events?.received ?? 0) >= 2, "events.received ≥ 2", String(health?.events?.received));
check((health?.events?.persisted ?? 0) >= 2, "events.persisted ≥ 2 (los dos guardados)", String(health?.events?.persisted));
check((health?.events?.snapshots ?? 0) >= 2, "events.snapshots ≥ 2 (fotos subidas)", String(health?.events?.snapshots));
check((health?.events?.snapshotFailures ?? 0) === 0, "sin fallos de subida", String(health?.events?.snapshotFailures));
check(Boolean(health?.webhooks), "GET /api/health informa de `webhooks`", JSON.stringify(health?.webhooks ?? {}).slice(0, 110));
check((health?.webhooks?.active ?? 0) >= 2, "webhooks.active ≥ 2", String(health?.webhooks?.active));
check((health?.webhooks?.deliveries ?? 0) >= 2, "webhooks.deliveries ≥ 2", String(health?.webhooks?.deliveries));
check((health?.webhooks?.failures ?? 0) >= 1, "webhooks.failures ≥ 1", String(health?.webhooks?.failures));

const openapi = await fetch(`${BASE}/api/openapi.json`).then((r) => r.json());
const paths = Object.keys(openapi.paths ?? {});
check(paths.includes("/api/v1/events"), "OpenAPI documenta GET /api/v1/events");
check(paths.includes("/api/v1/events/{id}"), "OpenAPI documenta DELETE /api/v1/events/{id}");
check(paths.includes("/api/v1/webhooks"), "OpenAPI documenta POST/GET /api/v1/webhooks");
check(paths.includes("/api/v1/webhooks/{id}"), "OpenAPI documenta DELETE /api/v1/webhooks/{id}");
check(Boolean(openapi.components?.schemas?.Event), "OpenAPI declara el schema Event");
check(Boolean(openapi.components?.schemas?.Webhook), "OpenAPI declara el schema Webhook");

const docsHtml = await fetch(`${BASE}/api/docs`).then((r) => r.text());
check(docsHtml.includes("Eventos y webhooks"), "el /api/docs explica los webhooks");
check(docsHtml.includes("x-cameras-signature"), "el /api/docs documenta la firma");

// ---------------------------------------------------------------------------
// 10. limpieza: lo que crea este test se borra
// ---------------------------------------------------------------------------
const eventIds = hooks.map((h) => JSON.parse(h.body).id).filter(Boolean);
let deletedEvents = 0;
for (const id of new Set(eventIds)) {
  const res = await fetch(`${BASE}/api/v1/events/${id}`, { method: "DELETE", headers: auth });
  if (res.status === 204) deletedEvents += 1;
  const again = await fetch(`${BASE}/api/v1/events/${id}`, { method: "DELETE", headers: auth });
  if (id === [...new Set(eventIds)][0]) check(again.status === 404, `DELETE /events/:id repetido → ${again.status}`);
}
check(deletedEvents === new Set(eventIds).size, `eventos borrados: ${deletedEvents}/${new Set(eventIds).size}`);

let deletedHooks = 0;
for (const id of [hookId, deadId].filter(Boolean)) {
  const res = await fetch(`${BASE}/api/v1/webhooks/${id}`, { method: "DELETE", headers: auth });
  if (res.status === 204) deletedHooks += 1;
}
check(deletedHooks === 2, `webhooks borrados: ${deletedHooks}/2`);
const hookGone = await fetch(`${BASE}/api/v1/webhooks/${hookId}`, { method: "DELETE", headers: auth });
check(hookGone.status === 404, `DELETE /webhooks/:id repetido → ${hookGone.status}`);

if (createdKeyId) {
  await fetch(`${BASE}/api/v1/keys/${createdKeyId}`, { method: "DELETE", headers: auth }).catch(() => {});
}

const finalList = await fetch(`${BASE}/api/v1/events?limit=20`, { headers: auth }).then((r) => r.json());
check(!(finalList.events ?? []).some((e) => eventIds.includes(e.id)), "los eventos de prueba ya no están listados");

agentSocket.disconnect();
viewerSocket.disconnect();
hookServer.close();

console.log(results.join("\n"));
console.log(failures === 0 ? "\nF6 OK" : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
