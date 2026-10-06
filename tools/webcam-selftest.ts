/**
 * F9 — auto-prueba de la webcam local (V4L2) como cámara IP.
 *
 *   npm run test:webcam
 *
 * 1. `devicePathOf` normaliza la conexión (`/dev/video0`, `video0`, vacía).
 * 2. `webcamEndpoint` traduce esa conexión a la URL MJPEG interna del agent.
 * 3. `buildClipArgs` re-tima los clips de webcam (sin `setpts` salían 2,5×
 *    acelerados) y no toca los de RTSP.
 * 4. Con el agent levantado y una webcam real (`/dev/video0`):
 *      - `/api/webcam` informa del estado de la captura,
 *      - `/webcam.jpg` en loopback devuelve un JPEG,
 *      - desde fuera de loopback responde 403 (privacidad),
 *      - dos clientes MJPEG concurrentes reciben frames,
 *      - **sólo un proceso** tiene el dispositivo abierto (V4L2 es exclusivo).
 *    Sin agent o sin webcam, esos pasos se omiten (no cuentan como fallo).
 */
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { buildClipArgs } from "../apps/agent/src/clip";
import { config } from "../apps/agent/src/config";
import { devicePathOf, webcamEndpoint } from "../apps/agent/src/local/webcam";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

function skip(label: string, why: string): void {
  skipped += 1;
  console.log(`  ---   ${label} — omitido (${why})`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1-3: lógica pura
// ---------------------------------------------------------------------------

function logic(): void {
  console.log("[1] ruta del dispositivo");
  check("acepta la ruta completa", devicePathOf("/dev/video0") === "/dev/video0");
  check("acepta `video0`", devicePathOf("video0") === "/dev/video0");
  check("acepta `Video1` en mayúsculas", devicePathOf("Video1") === "/dev/video1");
  check("vacío → el valor por defecto", devicePathOf("  ") === "/dev/video0");

  console.log("[2] endpoint interno");
  const endpoint = webcamEndpoint("/dev/video0");
  check("apunta al servidor del agent", /^http:\/\/127\.0\.0\.1:\d+\/webcam\.mjpg/.test(endpoint), endpoint);
  check("codifica el dispositivo", endpoint.includes("device=%2Fdev%2Fvideo0"));
  check("llama al mismo dispositivo que `devicePathOf`", endpoint.endsWith(devicePathOf("video0").replace(/\//g, "%2F")));

  console.log("[3] argumentos de clip (F7)");
  const webcamArgs = buildClipArgs(
    { cameraId: "selftest", sourceType: "webcam", connection: "/dev/video0" },
    "/tmp/clip.mp4",
    15000,
  );
  const asText = webcamArgs.join(" ");
  const vf = webcamArgs[webcamArgs.indexOf("-vf") + 1] ?? "";
  check("re-tima al ritmo real de la captura", vf.includes(`setpts=N/${config.webcamFps}/TB`), vf);
  check("recoge a 640 px para que quepa en el safety-net", vf.includes("scale='min(640,iw)':-2"), vf);
  check("lee de la URL interna, no del dispositivo", asText.includes("/webcam.mjpg?device="));
  check("codifica con ultrafast", asText.includes("-preset ultrafast"));
  check("graba 15 s", asText.includes("-t 15"));

  const rtspArgs = buildClipArgs(
    { cameraId: "selftest", sourceType: "rtsp", connection: "rtsp://192.168.1.10/live" },
    "/tmp/clip.mp4",
    15000,
  );
  const rtspText = rtspArgs.join(" ");
  check("RTSP sigue con -c:v copy", rtspText.includes("-c:v copy"));
  check("RTSP sin filtros", !rtspText.includes("-vf"));
}

// ---------------------------------------------------------------------------
// 4: contra el agent en vivo
// ---------------------------------------------------------------------------

const AGENT = "http://127.0.0.1:4100";
const DEVICE = "/dev/video0";

/** Procesos con el dispositivo abierto (V4L2 sólo admite uno). */
function countDeviceOpeners(device: string): number {
  const openers = new Set<string>();
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return -1;
  }
  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // el proceso ha salido entre medias
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === device) {
          openers.add(pid);
          break;
        }
      } catch {
        // descriptor cerrado o sin permisos: se ignora
      }
    }
  }
  return openers.size;
}

/** IP local no-interna (para comprobar el 403 fuera de loopback). */
function lanIp(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

/** Bytes que llegan de un flujo MJPEG durante `ms` (la conexión se corta sola). */
async function bytesReceived(url: string, ms: number): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  let bytes = 0;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) return -1;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
    }
  } catch {
    // la abrupción del timeout es lo esperado
  } finally {
    clearTimeout(timer);
  }
  return bytes;
}

async function live(): Promise<void> {
  let status: { webcam?: unknown } | null = null;
  try {
    status = (await (await fetch(`${AGENT}/api/webcam`, { signal: AbortSignal.timeout(3000) })).json()) as {
      webcam?: unknown;
    };
  } catch {
    status = null;
  }

  if (!status) {
    skip("estado de la captura", "el agent no está en :4100");
    skip("snapshot, 403 y reparto", "el agent no está en :4100");
    return;
  }
  check("GET /api/webcam contesta", Array.isArray(status.webcam), JSON.stringify(status.webcam));

  const deviceExists = existsSync(DEVICE);
  if (!deviceExists) {
    skip("snapshot / 403 / reparto", `no hay webcam en ${DEVICE}`);
    return;
  }

  // snapshot desde loopback
  const snap = await fetch(`${AGENT}/webcam.jpg?device=${encodeURIComponent(DEVICE)}`, {
    signal: AbortSignal.timeout(8000),
  });
  const body = Buffer.from(await snap.arrayBuffer());
  check("GET /webcam.jpg en loopback devuelve un JPEG", snap.ok && body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), `http=${snap.status} ${body.length} B`);

  // fuera de loopback → 403
  const ip = lanIp();
  if (!ip) {
    skip("403 fuera de loopback", "no hay IP de LAN");
  } else {
    const denied = await fetch(`http://${ip}:4100/webcam.jpg?device=${encodeURIComponent(DEVICE)}`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    check("desde la LAN la webcam responde 403", denied?.status === 403, `http=${denied?.status ?? "sin respuesta"}`);
  }

  // dos clientes concurrentes reciben el flujo (fan-out)
  const [a, b] = await Promise.all([
    bytesReceived(`${AGENT}/webcam.mjpg?device=${encodeURIComponent(DEVICE)}`, 4000),
    bytesReceived(`${AGENT}/webcam.mjpg?device=${encodeURIComponent(DEVICE)}`, 4000),
  ]);
  check("dos clientes concurrentes reciben el flujo", a > 0 && b > 0, `cliente A=${a} B, cliente B=${b} B`);

  // el invariante de F9: un único dueño del dispositivo
  const openers = countDeviceOpeners(DEVICE);
  check("un solo proceso con el dispositivo abierto", openers === 1, `${openers} procesos`);

  const after = (await (await fetch(`${AGENT}/api/webcam`)).json()) as { webcam?: unknown };
  console.log(`        estado final: ${JSON.stringify(after.webcam)}`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logic();
  await live();
  await sleep(500);

  console.log(`\n[webcam] ${passed} ok, ${failed} fallos, ${skipped} omitidos`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
