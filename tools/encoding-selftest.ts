/**
 * Selftest: aplicar una codificación nueva a un pipeline EN MARCHA tiene que
 * reiniciar FFmpeg.
 *
 * Si no se reinicia, el vídeo sigue saliendo con la resolución antigua mientras
 * `reportStatus()` (que lee `this.spec`, ya actualizado) dice en el server y en
 * el panel que la configuración nueva está aplicada.
 *
 * Uso: npx tsx tools/encoding-selftest.ts   (o npm run test:encoding)
 *
 * Comprueba también (8) que un reinicio mientras FFmpeg aún estaba «starting»
 * no deja el pipeline zombi: sin proceso, sin timers y con el spec nuevo sólo
 * en el reporte — el caso exacto de una cámara que cambia de IP.
 */
import { MjpegPipeline } from "../apps/agent/src/pipeline/mjpeg";
import { sanitizeEncoding, type SourceSpec } from "../apps/agent/src/pipeline/args";

type Any = any;

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
}

/** Crea un pipeline con `state="running"` y espión de `restart()`. */
function running(spec: Partial<SourceSpec>) {
  const p = new MjpegPipeline({
    cameraId: "cam-test",
    sourceType: "rtsp",
    connection: "rtsp://192.168.0.10/stream",
    ...spec,
  } as SourceSpec) as Any;
  p.state = "running";
  let restarts = 0;
  p.restart = () => {
    restarts += 1; // no se arranca FFmpeg de verdad: sólo contamos la llamada
  };
  return {
    pipeline: p,
    get restarts() {
      return restarts;
    },
    encoding: () => p.reportStatus().encoding as { width: number; fps: number },
    currentSpec: () => p.spec as SourceSpec,
  };
}

// 1) Cámara nueva: spec SIN width/fps (defaults 640@2) y llega 160@0.5.
{
  const p = running({});
  p.pipeline.applyEncoding({ width: 160, fps: 0.5 });
  check(
    "1. spec sin resolución + applyEncoding(160@0.5) reinicia",
    p.restarts === 1,
    `restarts=${p.restarts} (esperado 1)`
  );
  check(
    "1b. el spec refleja la codificación nueva",
    p.currentSpec().width === 160 && p.currentSpec().fps === 0.5,
    `spec=${JSON.stringify({ w: p.currentSpec().width, f: p.currentSpec().fps })}`
  );
}

// 2) Spec con 640@2 explícito y llega 160@0.5.
{
  const p = running({ width: 640, fps: 2 });
  p.pipeline.applyEncoding({ width: 160, fps: 0.5 });
  check(
    "2. 640@2 -> 160@0.5 reinicia",
    p.restarts === 1,
    `restarts=${p.restarts} (esperado 1)`
  );
}

// 3) Misma codificación: no debe reiniciar (evita cortar el vídeo).
{
  const p = running({ width: 160, fps: 0.5 });
  p.pipeline.applyEncoding({ width: 160, fps: 0.5 });
  check(
    "3. codificación idéntica no reinicia",
    p.restarts === 0,
    `restarts=${p.restarts} (esperado 0)`
  );
}

// 4) Cambio sólo de fps.
{
  const p = running({ width: 320, fps: 2 });
  p.pipeline.applyEncoding({ width: 320, fps: 0.5 });
  check(
    "4. sólo cambia el fps -> reinicia",
    p.restarts === 1,
    `restarts=${p.restarts} (esperado 1)`
  );
}

// 5) Un pipeline parado no debe arrancar FFmpeg al cambiar la codificación.
{
  const p = running({ width: 640, fps: 2 });
  (p.pipeline as Any).state = "stopped";
  p.pipeline.applyEncoding({ width: 160, fps: 0.5 });
  check(
    "5. pipeline parado: no reinicia (se aplicará al arrancar)",
    p.restarts === 0,
    `restarts=${p.restarts} (esperado 0)`
  );
  check(
    "5b. el spec sí queda actualizado para el próximo arranque",
    p.currentSpec().width === 160 && p.currentSpec().fps === 0.5,
    `spec=${JSON.stringify({ w: p.currentSpec().width, f: p.currentSpec().fps })}`
  );
}

// 6) El reporte de estado debe reflejar la codificación aplicada.
{
  const p = running({ width: 160, fps: 0.5 });
  const enc = p.encoding();
  check(
    "6. reportStatus() informa la codificación del spec",
    enc.width === 160 && enc.fps === 0.5,
    `reportado=${JSON.stringify(enc)}`
  );
}

// 7) Escalas por debajo de 160x90: el saneado no debe recortarlas a 160.
{
  const a = sanitizeEncoding({ width: 128, fps: 0.5 });
  const b = sanitizeEncoding({ width: 96, fps: 0.5 });
  const c = sanitizeEncoding({ width: 64, fps: 0.5 });
  check(
    "7. 128 / 96 / 64 px se conservan (nuevas escalas)",
    a.width === 128 && b.width === 96 && c.width === 64,
    `widths=${[a.width, b.width, c.width].join(",")}`
  );
  check(
    "7b. por debajo del mínimo cae al mínimo par y el impar al par inferior",
    sanitizeEncoding({ width: 50 }).width === 64 && sanitizeEncoding({ width: 97 }).width === 96,
    `50→${sanitizeEncoding({ width: 50 }).width}, 97→${sanitizeEncoding({ width: 97 }).width}`
  );
}

// 8) Un reinicio sobre un pipeline «starting» (cámara inalcanzable: FFmpeg
//    lanzado, sin primer frame) no puede dejarlo zombi: sin proceso, sin
//    timers y con `start()` cortado por su guard de «starting». Con el bug el
//    spec nuevo se quedaba sólo en el reporte y nadie volvía a lanzar FFmpeg.
{
  const p = new MjpegPipeline({
    cameraId: "cam-zombi",
    sourceType: "rtsp",
    connection: "rtsp://192.168.0.10/stream",
    width: 640,
    fps: 2,
  } as SourceSpec) as Any;
  p.state = "starting";
  p.proc = null; // estado observado en producción tras abortar la conexión

  p.updateSpec({ ...p.spec, connection: "rtsp://198.51.100.7/live", width: 64, fps: 0.5 });

  const zombi = p.state === "starting" && !p.proc;
  check(
    "8. el reinicio en «starting» no deja el pipeline sin proceso",
    !zombi,
    `state=${p.state} proc=${p.proc ? "lanzado" : "null"}${zombi ? " (zombi)" : ""}`
  );
  check(
    "8b. la nueva conexión queda en el spec (lo que usará el próximo FFmpeg)",
    p.spec.connection === "rtsp://198.51.100.7/live" && p.spec.width === 64 && p.spec.fps === 0.5,
    `spec=${JSON.stringify({ c: String(p.spec.connection).replace(/\/\/[^@/]+@/, "//***@"), w: p.spec.width, f: p.spec.fps })}`
  );
  p.stop(); // mata el FFmpeg de prueba y limpia timers
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "  ok  " : "FALLO "} ${r.name} — ${r.detail}`);
console.log(
  failed.length === 0
    ? `\nencoding-selftest: ${results.length}/${results.length} comprobaciones correctas`
    : `\nencoding-selftest: ${failed.length} fallo(s) de ${results.length}`
);
process.exit(failed.length === 0 ? 0 : 1);
