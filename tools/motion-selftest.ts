/**
 * F6 — auto-prueba de la detección de movimiento (sin cámara real).
 *
 *   npm run test:motion
 *
 * 1. `parseSceneScore` lee `lavfi.scene_score=…` de los logs de FFmpeg.
 * 2. `splitJpegFrames` separa JPEG concatenados (mismo código que el pipeline).
 * 3. FFmpeg + `testsrc` con umbral BAJO  → sí detecta y la imagen es un JPEG válido.
 * 4. FFmpeg + `testsrc` con umbral ALTÍSIMO → no detecta, pero sigue midiendo.
 *
 * Todo con la fuente sintética del propio FFmpeg: determinista y rápido (~14 s).
 */
import { motionSettings, parseSceneScore } from "@cameras/core";
import { MotionWatcher, buildMotionArgs, type MotionDetection } from "../apps/agent/src/motion";
import { splitJpegFrames } from "../apps/agent/src/pipeline/jpeg";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, extra = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);

function fakeJpeg(marker: number): Buffer {
  return Buffer.concat([SOI, Buffer.from([marker, marker, marker, marker]), EOI]);
}

interface WatcherRun {
  detections: MotionDetection[];
  watcher: MotionWatcher;
  stop: () => void;
}

/**
 * Watchers vivos. `testsrc` no se acaba nunca: si la herramienta se interrumpe
 * (Ctrl+C, timeout) sin pasar por `stop()`, FFmpeg queda huérfano y se come la
 * CPU de la máquina. Estos ganchos loatan en cualquier salida.
 */
const liveWatchers = new Set<MotionWatcher>();

function stopAllWatchers(): void {
  for (const watcher of liveWatchers) watcher.stop();
  liveWatchers.clear();
}

process.on("exit", stopAllWatchers);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopAllWatchers();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

/** Lanza un watcher sobre la fuente sintética `testsrc` y lo deja corriendo. */
function startWatcher(threshold: number): WatcherRun {
  process.env.MOTION_THRESHOLD = String(threshold);
  process.env.MOTION_FPS = "2";

  const detections: MotionDetection[] = [];
  const watcher = new MotionWatcher(
    { cameraId: "selftest", sourceType: "test", connection: "test://selftest" },
    (detection) => detections.push(detection),
  );
  watcher.start();
  liveWatchers.add(watcher);
  const stop = () => {
    watcher.stop();
    liveWatchers.delete(watcher);
  };
  return { detections, watcher, stop };
}

async function main() {
  console.log("\n[motion] 1. parseSceneScore");
  const parsed = parseSceneScore("[Parsed_metadata_3 @ 000001e5c2956a80] lavfi.scene_score=0.123456");
  check("lee un score decimal", parsed !== null && Math.abs(parsed - 0.123456) < 1e-9, String(parsed));
  check("lee cero", parseSceneScore("lavfi.scene_score=0.000000") === 0);
  check("lee uno", parseSceneScore("lavfi.scene_score=1.000000") === 1);
  check("ignora el resto de líneas", parseSceneScore("Input #0, lavfi, from 'color=c=blue'") === null);
  check("ignora líneas vacías", parseSceneScore("") === null);

  console.log("\n[motion] 2. splitJpegFrames");
  const j1 = fakeJpeg(0x11);
  const j2 = fakeJpeg(0x22);
  const both = Buffer.concat([j1, Buffer.from([0x00, 0x01]), j2]);
  const whole = splitJpegFrames(both);
  check("separa dos frames con basura entre ellos", whole.frames.length === 2, `${whole.frames.length}`);
  check("el primer frame es completo", whole.frames[0]?.equals(j1) ?? false);
  check("el segundo frame es completo", whole.frames[1]?.equals(j2) ?? false);
  check("sin restos", whole.rest.length === 0);

  const partial = splitJpegFrames(Buffer.concat([j1, Buffer.from([0xff, 0xd8])]));
  check("un SOI partido entre chunks se conserva", partial.frames.length === 1 && partial.rest.length === 2, `frames=${partial.frames.length} rest=${partial.rest.length}`);

  const oneByte = splitJpegFrames(Buffer.concat([j1, Buffer.from([0xff])]));
  check("un último byte suelto se conserva", oneByte.frames.length === 1 && oneByte.rest.length === 1, `rest=${oneByte.rest.length}`);

  const clean = splitJpegFrames(Buffer.concat([j1, Buffer.from("hola")]));
  check("del sobrante sólo se guardan 2 bytes", clean.frames.length === 1 && clean.rest.length === 2, `rest=${clean.rest.length}`);

  const cut = splitJpegFrames(both.subarray(0, both.length - 1));
  check("un EOI partido no se entrega", cut.frames.length === 1, `${cut.frames.length}`);

  const overflow = splitJpegFrames(Buffer.alloc(9 * 1024 * 1024, 0x42));
  check("buffer desbordado se marca como overflow", overflow.overflow && overflow.frames.length === 0);

  const orphan = splitJpegFrames(Buffer.from([0x01, 0x02, 0x03]));
  check("basura sin SOI no devuelve frames", orphan.frames.length === 0);

  console.log("\n[motion] 3. detector FFmpeg con umbral bajo (debe detectar)");
  const low = startWatcher(0.01);
  await sleep(9000);
  const lowStatus = low.watcher.status();
  low.stop();

  check(
    "mide puntuaciones de escena (stderr)",
    lowStatus.scores > 0,
    `${lowStatus.scores} muestras, máx ${lowStatus.maxScore.toFixed(4)}, estado ${lowStatus.state}`,
  );
  check("el proceso arranca y corre", lowStatus.state === "running", lowStatus.state);
  const withJpeg = low.detections.filter((d) => d.jpeg && d.jpeg.length > 0);
  check("ha producido avisos", low.detections.length >= 1, `${low.detections.length} avisos`);
  check("cada aviso trae su JPEG", withJpeg.length === low.detections.length, `${withJpeg.length}/${low.detections.length}`);
  const first = low.detections[0]?.jpeg;
  check(
    "la imagen es un JPEG válido (SOI…EOI)",
    Boolean(first && first.length > 1000 && first.subarray(0, 3).equals(SOI) && first.subarray(first.length - 2).equals(EOI)),
    first ? `${first.length} B` : "sin imagen",
  );
  check(
    "la puntuación reportada supera el umbral",
    low.detections.every((d) => d.score >= 0.01),
    low.detections.map((d) => d.score.toFixed(3)).join(", "),
  );
  const jpegTotal = low.detections.length + lowStatus.suppressed;
  check(
    "la 2ª salida sólo emite JPEG al pasar el umbral",
    jpegTotal <= lowStatus.scores,
    `jpeg=${jpegTotal} de ${lowStatus.scores} muestras (enfriados=${lowStatus.suppressed})`,
  );

  console.log("\n[motion] 4. detector FFmpeg con umbral imposible (no debe detectar)");
  const high = startWatcher(0.99);
  await sleep(7000);
  const highStatus = high.watcher.status();
  high.stop();
  check("sigue midiendo sin disparar", highStatus.scores > 0, `${highStatus.scores} muestras, máx ${highStatus.maxScore.toFixed(4)}`);
  check("sin avisos con umbral 0.99", high.detections.length === 0, `${high.detections.length}`);
  check("los avisos suprimidos se contabilizan", highStatus.suppressed === 0, `${highStatus.suppressed}`);

  console.log("\n[motion] 5. buildMotionArgs");
  process.env.MOTION_THRESHOLD = "0.15";
  const args = buildMotionArgs({ cameraId: "x", sourceType: "rtsp", connection: "rtsp://user:pass@h/Streaming/Channels/101" });
  const joined = args.join(" ");
  check("no lee de stdin", args[0] === "-nostdin");
  check("transporte RTSP por TCP", joined.includes("-rtsp_transport tcp"));
  check("loglevel info (hace falta para metadata=print)", joined.includes("-loglevel info"));
  check("imprime la puntuación por stderr", joined.includes("metadata=print"));
  check("umbral en el select de salida", joined.includes("gt(scene,0.15)"));
  check("dos salidas (null + image2pipe)", args.filter((a) => a === "-f").length === 2);
  check("la credencial RTSP no se rompe", joined.includes("rtsp://user:pass@h/Streaming/Channels/101"));

  console.log("\n[motion] configuración:", JSON.stringify(motionSettings()));
  console.log(`\n[motion] resultado: ${passed} ok, ${failed} fallos\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("\n[motion] error inesperado:", error);
  process.exitCode = 1;
});
