import { config } from "./config";
import { checkFfmpeg, ensureDataDir } from "./pipeline/ffmpeg";
import { PipelineRegistry, type AgentCamera } from "./pipeline/registry";
import { EncodingStore } from "./pipeline/encoding";
import { createStreamServer } from "./local/streamServer";
import { connectToServer, type ServerTransport } from "./transport/server";
import { RelayController } from "./relay";
import { MotionManager } from "./motionManager";
import { ClipManager, measureClipsDir } from "./clip";
import { clipSettings, motionSettings } from "@cameras/core";
import type { AgentHello } from "@cameras/protocol";

const encodingStore = new EncodingStore(config.dataDir);
const registry = new PipelineRegistry(encodingStore);
const motion = new MotionManager();
const clips = new ClipManager();

// El transport se crea dentro de main(); el detector necesita enviar avisos
// desde el primer segundo, así que se resuelve con una referencia perezosa.
const transportRef: { current: ServerTransport | null } = { current: null };
motion.setEmitter((event) => transportRef.current?.emitEvent(event) ?? false);
clips.setEmitter((clip) => transportRef.current?.emitClipReady(clip) ?? false);
motion.setClipRecorder(clips);

// F6: si el proceso sale sin señal (reinicio de `tsx watch`, fin de sesión),
// se matan los FFmpeg en marcha: sin esto quedan huérfanos abriendo sesiones
// RTSP a la cámara y robando fps al relay. Las salidas normales pasan por
// `shutdown()`; este gancho es la red de seguridad.
process.on("exit", () => {
  motion.stopAll();
  clips.stopAll();
  registry.stopAll();
});

/** Descarga la lista de cámaras (con conexión) desde el server. */
async function syncCameras(): Promise<boolean> {
  try {
    const response = await fetch(`${config.serverUrl}/api/agent/cameras`, {
      headers: config.agentTokenOut ? { "x-agent-token": config.agentTokenOut } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(`[agent] sync rechazado: HTTP ${response.status}`);
      return false;
    }
    const data = (await response.json()) as { cameras: AgentCamera[] };
    const cameras = data.cameras ?? [];
    registry.sync(cameras);
    motion.sync(cameras); // F6: detectores de movimiento de las cámaras activas
    clips.sync(cameras); // F7: specs para grabar clips cuando haya aviso o petición
    return true;
  } catch (error) {
    console.warn(`[agent] sync falló: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main() {
  const motionConfig = motionSettings();
  const clipsConfig = clipSettings();
  console.log(`
  📹  cameras-center agent
      id      ${config.agentId}
      server  ${config.serverUrl}
      stream  http://localhost:${config.streamPort}
      data    ${ensureDataDir()}
      motion  ${motionConfig.enabled ? `activa (umbral ${motionConfig.threshold}, ${motionConfig.sampleFps} fps, espera ${motionConfig.cooldownMs} ms)` : "desactivada"}
      clips   ${clipsConfig.enabled ? `${Math.round(clipsConfig.durationMs / 1000)} s por aviso (conserva ${clipsConfig.keep})` : "automáticos off (sólo manual)"}
`);

  const ffmpeg = await checkFfmpeg();
  if (ffmpeg.ok) {
    console.log(`  ✅ FFmpeg: ${ffmpeg.version}`);
    console.log(`     ${ffmpeg.path}\n`);
  } else {
    console.warn(`  ⚠️  ${ffmpeg.error}`);
    console.warn("     Instálalo o define FFMPEG_PATH en .env\n");
  }

  await syncCameras();

  // --- Relay al server (F3) --------------------------------------------------
  // El RelayController necesita el socket y el socket necesita al controller:
  // se resuelve con un contenedor que se rellena un par de líneas más abajo.
  const relay = new RelayController(registry, () => transportRef.current?.socket ?? null);

  // F6: el agent declara que sabe detectar movimiento si la detección está activa
  // F7: y que sabe grabar clips (siempre: los manuales funcionan igualmente)
  const capabilities: AgentHello["capabilities"] = ["rtsp", "mjpeg", "test", "record"];
  if (motionSettings().enabled) capabilities.push("motion");

  const transport = connectToServer(
    () => ({
      agentId: config.agentId,
      version: config.version,
      cameras: registry.listCameras(),
      capabilities,
    }),
    {
      onStartStream: (cameraId) => relay.attach(cameraId),
      onStopStream: (cameraId, reason) => relay.detach(cameraId, reason),
      onDisconnect: () => relay.detachAll("sin conexión al server"),
      onRecordClip: (cameraId, durationMs) => clips.record(cameraId, "manual", durationMs),
      onSetEncoding: (cameraId, width, fps) => {
        const ok = registry.setEncoding(cameraId, { width, fps });
        console.log(`[agent] setEncoding ${cameraId}: ${ok ? "aplicado" : "cámara desconocida"}`);
      },
    },
  );
  transportRef.current = transport;

  // --- Servidor de streams local (visión en LAN) ---
  const streamServer = createStreamServer(
    registry,
    config.streamPort,
    () => motion.status(),
    () => clips.status(),
  );
  streamServer.listen(config.streamPort, () => {
    console.log(`  🎞  stream   http://localhost:${config.streamPort}/stream/:id.mjpg\n`);
  });

  // --- Bucles de mantenimiento ---
  const syncTimer = setInterval(() => void syncCameras(), config.syncIntervalMs);
  const statusTimer = setInterval(() => {
    for (const pipeline of registry.all()) {
      transport.emitStatus(pipeline.reportStatus());
    }
  }, 10000);
  // Uso de disco local para el panel de almacenamiento (cada 60 s).
  const diskTimer = setInterval(() => {
    const usage = measureClipsDir(config.dataDir);
    transport.emitDisk({
      type: "agent:disk",
      agentId: config.agentId,
      clipsBytes: usage.clipsBytes,
      clips: usage.clips,
      at: Date.now(),
    });
  }, 60_000);

  const shutdown = () => {
    console.log("\n[agent] apagando...");
    clearInterval(syncTimer);
    clearInterval(statusTimer);
    clearInterval(diskTimer);
    relay.detachAll("shutdown");
    motion.stopAll();
    clips.stopAll();
    registry.stopAll();
    streamServer.close();
    transport.socket.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[agent] error fatal:", error);
  process.exit(1);
});
