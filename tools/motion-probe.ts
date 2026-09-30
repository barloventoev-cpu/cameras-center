/**
 * npm run probe:motion — sonda de umbral contra la cámara real (F6).
 *
 * Lanza el MISMO FFmpeg que usa el agent (mismos argumentos) y, durante N
 * segundos, compara lo que cuentan las dos salidas:
 *
 *   stderr → puntuación de escena de cada muestra (lavfi.scene_score)
 *   stdout → JPEG emitidos al superar el umbral
 *
 * Si ambas cifras coinciden, la cadena de filtros está bien y el umbral sólo
 * depende de la escena; si no, hay un problema de configuración.
 *
 * Uso:
 *   npm run probe:motion                      # 45 s, primera cámara, umbral actual
 *   npm run probe:motion -- --segundos 120
 *   npm run probe:motion -- --umbral 0.02
 *   npm run probe:motion -- --camara <id|nombre>
 *   npm run probe:motion -- --test            # fuente sintética (sin cámara)
 *
 * La cámara se lee de Supabase y la URL RTSP se descifra con CAMERA_ENC_KEY;
 * no se imprime la credencial por pantalla.
 */
import { spawn } from "node:child_process";
import { openSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptSecret, keyFromEnv, motionSettings, parseSceneScore } from "@cameras/core";
import { buildMotionArgs } from "../apps/agent/src/motion";
import { resolveFfmpegPath } from "../apps/agent/src/pipeline/ffmpeg";
import { splitJpegFrames } from "../apps/agent/src/pipeline/jpeg";
import type { SourceSpec } from "../apps/agent/src/pipeline/args";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envText = readFileSync(resolve(root, ".env"), "utf8");
const val = (n: string) => (envText.match(new RegExp(`^${n}=(.*)$`, "m")) ?? [])[1]?.trim() ?? "";

// --- argumentos de línea de comandos ----------------------------------------
const argv = process.argv.slice(2);
const opt = (name: string, fallback = ""): string => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const seconds = Number(opt("--segundos", "45")) || 45;
const thresholdArg = opt("--umbral", "");
const cameraArg = opt("--camara", "");
const useTest = argv.includes("--test");
if (thresholdArg) process.env.MOTION_THRESHOLD = thresholdArg;

const redact = (url: string) => url.replace(/\/\/[^@/]*@/, "//***:***@");

/** FFmpeg en curso: si la sonda se interrumpe no queda un proceso huérfano. */
let activeProc: ReturnType<typeof spawn> | null = null;

function killActive(): void {
  if (!activeProc) return;
  try {
    activeProc.kill("SIGKILL");
  } catch {
    // ya terminado
  }
  activeProc = null;
}

process.on("exit", killActive);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    killActive();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

/** Percentil (0..1) de una lista ordenada de puntuaciones. */
const pct = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);

async function main(): Promise<void> {
  const settings = motionSettings();
  const bin = resolveFfmpegPath();
  if (!bin) {
    console.error("[probe] FFmpeg no encontrado");
    process.exitCode = 1;
    return;
  }

  let spec: SourceSpec;
  if (useTest) {
    spec = { cameraId: "probe", sourceType: "test", connection: "test://probe" };
  } else {
    const supabaseUrl = val("SUPABASE_URL");
    const serviceKey = val("SUPABASE_SERVICE_KEY");
    if (!supabaseUrl || !serviceKey) {
      console.error("[probe] faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en .env");
      process.exitCode = 1;
      return;
    }
    const res = await fetch(`${supabaseUrl}/rest/v1/cameras?select=id,name,source_type,host,connection_encrypted&order=sort_order.asc`, {
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    });
    const rows = (await res.json()) as Array<{
      id: string;
      name: string;
      source_type: string;
      host: string;
      connection_encrypted: string | null;
    }>;
    if (!res.ok || !Array.isArray(rows) || rows.length === 0) {
      console.error(`[probe] no hay cámaras en Supabase (${res.status})`);
      process.exitCode = 1;
      return;
    }
    const wanted = cameraArg.toLowerCase();
    const cam =
      rows.find((r) => r.id.toLowerCase() === wanted) ??
      rows.find((r) => r.name.toLowerCase().includes(wanted)) ??
      rows[0];
    if (!cam) {
      console.error("[probe] no hay cámaras en Supabase");
      process.exitCode = 1;
      return;
    }
    if (!cam.connection_encrypted) {
      console.error(`[probe] la cámara «${cam.name}» no tiene URL guardada`);
      process.exitCode = 1;
      return;
    }
    const connection = decryptSecret(cam.connection_encrypted, keyFromEnv(val("CAMERA_ENC_KEY")));
    spec = { cameraId: cam.id, sourceType: (cam.source_type as SourceSpec["sourceType"]) ?? "rtsp", connection };
    console.log(`[probe] cámara: ${cam.name} (${cam.id.slice(0, 8)}) — ${redact(connection)}`);
  }

  const args = buildMotionArgs(spec);
  console.log(
    `[probe] umbral ${settings.threshold} · muestreo ${settings.sampleFps} fps · ancho ${settings.snapshotWidth} · ${seconds} s`,
  );

  const fileOut = opt("--archivo", "");
  const outFd = fileOut ? openSync(fileOut, "w") : null;

  const t0 = Date.now();
  const proc = spawn(bin, args, { windowsHide: true, stdio: ["ignore", outFd ?? "pipe", "pipe"] });
  activeProc = proc;

  const scores: number[] = [];
  const sampleTimes: number[] = [];
  let stderrTail = "";
  let buf: Buffer = Buffer.alloc(0);
  let jpegs = 0;
  let jpegBytes = 0;
  /** Instante (ms desde el inicio) y tamaño de cada JPEG recibido. */
  const jpegTimes: number[] = [];
  const jpegSizes: number[] = [];

  /** `--archivo`: se vigila el crecimiento del fichero de salida. */
  if (fileOut) {
    const startedPoll = Date.now();
    const poll = setInterval(() => {
      try {
        const size = statSync(fileOut).size;
        console.log(`  .. ${((Date.now() - startedPoll) / 1000) | 0}s fichero ${(size / 1024).toFixed(0)} kB`);
      } catch {
        /* aún no existe */
      }
    }, 2000);
    proc.on("close", () => clearInterval(poll));
  }

  proc.stdout?.on("data", (chunk: Buffer) => {
    const merged = buf.length > 0 ? Buffer.concat([buf, chunk]) : chunk;
    const { frames, rest } = splitJpegFrames(merged);
    buf = rest;
    for (const frame of frames) {
      jpegs += 1;
      jpegBytes += frame.length;
      jpegTimes.push(Date.now() - t0);
      jpegSizes.push(frame.length);
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrTail += chunk.toString("utf8");
    const lines = (stderrTail.match(/[^\r\n]*[\r\n]/g) ?? []).filter((l) => l.trim().length > 0);
    stderrTail = stderrTail.slice(lines.join("").length);
    for (const line of lines) {
      const score = parseSceneScore(line);
      if (score !== null) {
        scores.push(score);
        sampleTimes.push(Date.now() - t0);
      }
    }
  });

  proc.on("error", (error) => {
    console.error("[probe] error al lanzar FFmpeg:", error.message);
    process.exitCode = 1;
  });

  const started = Date.now();
  await new Promise<void>((r) => {
    const tick = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      if (elapsed % 15 < 1) {
        console.log(`  … ${(elapsed | 0)}/${seconds} s · muestras ${scores.length} · JPEG ${jpegs}`);
      }
      if (elapsed >= seconds) {
        clearInterval(tick);
        r();
      }
    }, 1000);
  });

  proc.kill("SIGKILL");
  activeProc = null;
  await new Promise((r) => setTimeout(r, 300));

  const sorted = [...scores].sort((a, b) => a - b);
  const noise = pct(sorted, 0.95);
  const peak = sorted.length ? (sorted[sorted.length - 1] ?? 0) : 0;
  const median = pct(sorted, 0.5);
  const high = scores.filter((s) => s >= settings.threshold).length;

  console.log("\n[probe] resultado");
  console.log(`  muestras (stderr)          ${scores.length}`);
  console.log(`  mediana / ruido p95        ${median.toFixed(6)} / ${noise.toFixed(6)}`);
  console.log(`  máximo observado           ${peak.toFixed(6)}`);
  console.log(`  ≥ umbral ${settings.threshold}          ${high}`);
  console.log(`  JPEG emitidos (stdout)     ${jpegs} (${(jpegBytes / 1024).toFixed(0)} kB)`);
  if (jpegs > 0) {
    const first = jpegTimes[0] ?? 0;
    const last = jpegTimes[jpegTimes.length - 1] ?? 0;
    console.log(`  1.er JPEG / último         t=${(first / 1000).toFixed(1)} s / t=${(last / 1000).toFixed(1)} s`);
    console.log(`  tamaños distintos          ${new Set(jpegSizes).size}/${jpegSizes.length}`);
  }
  if (fileOut) console.log(`  salida escrita en          ${fileOut}`);

  if (scores.length === 0) {
    console.log("\n[probe] sin puntuaciones: FFmpeg no pudo leer la fuente (¿URL o red?)");
    process.exitCode = 1;
    return;
  }

  if (!fileOut) {
    const delta = Math.abs(high - jpegs);
    const coherent = jpegs > 0 ? delta <= Math.max(2, Math.ceil(jpegs * 0.2)) : high === 0;
    console.log(
      coherent
        ? `  diagnóstico                ambas salidas coinciden (${high} vs ${jpegs}) ✅`
        : `  diagnóstico                DISCREPANCIA: ${high} muestras ≥ umbral vs ${jpegs} JPEG ❌`,
    );
  }

  // Línea del tiempo: cada JPEG se atribuye a la muestra más cercana, para ver
  // con qué puntuación coincidió realmente la salida 2.
  if (!fileOut) {
    const assigned = new Array<number>(scores.length).fill(0);
  for (const t of jpegTimes) {
    for (let i = sampleTimes.length - 1; i >= 0; i -= 1) {
      if ((sampleTimes[i] ?? 0) <= t + 400) {
        assigned[i] = (assigned[i] ?? 0) + 1;
        break;
      }
    }
  }
  console.log("\n[probe] línea del tiempo (sólo filas con JPEG o score ≥ umbral)");
  console.log("   t(s)     score    jpeg");
  let shown = 0;
  let coincidentes = 0;
  for (let i = 0; i < scores.length; i += 1) {
    const score = scores[i] ?? 0;
    const n = assigned[i] ?? 0;
    if (n === 0 && score < settings.threshold) continue;
    if (n > 0 && score >= settings.threshold) coincidentes += 1;
    if (shown < 40) {
      const t = ((sampleTimes[i] ?? 0) / 1000).toFixed(1).padStart(5);
      console.log(`  ${t}   ${score.toFixed(6)}   ${n === 0 ? "-" : String(n).padStart(2)}`);
    }
    shown += 1;
  }
  if (shown === 0) console.log("  (ninguna fila: ni JPEG ni puntuaciones altas)");
  else if (shown > 40) console.log(`  … y ${shown - 40} filas más`);
  console.log(`  JPEG sobre puntuación ≥ umbral: ${coincidentes}/${jpegs}`);
  }

  const suggested =
    peak > 3 * Math.max(noise, 1e-6)
      ? Math.max(0.01, Math.round(((noise + peak) / 2) * 100) / 100)
      : Math.max(0.01, Math.round(noise * 3 * 100) / 100);
  console.log(`\n[probe] umbral sugerido: MOTION_THRESHOLD=${suggested}`);
  if (high > 0 && peak > 3 * Math.max(noise, 1e-6)) {
    console.log("[probe] hubo movimiento durante la sonda: el umbral queda entre el ruido y ese pico.");
  } else {
    console.log("[probe] sin movimiento claro: el umbral propuesto es 3× el ruido máximo de reposo.");
  }
}

main().catch((error) => {
  console.error("[probe] error inesperado:", error);
  process.exitCode = 1;
});
