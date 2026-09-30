import { motionSettings } from "@cameras/core";
import type { AgentEvent } from "@cameras/protocol";
import { MotionWatcher, type MotionDetection, type MotionStatus } from "./motion";
import type { AgentCamera } from "./pipeline/registry";

export interface MotionManagerStatus {
  enabled: boolean;
  sampleFps: number;
  threshold: number;
  cooldownMs: number;
  snapshotWidth: number;
  cameras: MotionStatus[];
}

/**
 * F6 — supervisa la detección de movimiento de las cámaras activas.
 *
 * Arranca un `MotionWatcher` por cámara (sólo si `MOTION_ENABLED`), lo
 * reconecta cuando cambia la URL y entrega los avisos al transport del agent,
 * que los manda al server por `agent:event`.
 */
export class MotionManager {
  private watchers = new Map<string, MotionWatcher>();
  private emit: ((event: AgentEvent) => boolean) | null = null;
  private clips: { record(cameraId: string, trigger: "motion" | "manual"): boolean } | null = null;

  /** Se inyecta cuando el transport al server ya existe. */
  setEmitter(emit: (event: AgentEvent) => boolean): void {
    this.emit = emit;
  }

  /** F7: cada aviso arranca también un clip (si `CLIP_ENABLED`). */
  setClipRecorder(recorder: { record(cameraId: string, trigger: "motion" | "manual"): boolean }): void {
    this.clips = recorder;
  }

  sync(cameras: AgentCamera[]): void {
    const { enabled } = motionSettings();
    const wanted = new Set(enabled ? cameras.filter((camera) => camera.active).map((camera) => camera.id) : []);

    for (const [cameraId, watcher] of [...this.watchers]) {
      if (wanted.has(cameraId)) continue;
      watcher.stop();
      this.watchers.delete(cameraId);
    }
    if (!enabled) return;

    for (const camera of cameras) {
      if (!camera.active) continue;
      const spec = { cameraId: camera.id, sourceType: camera.sourceType, connection: camera.connection };
      const existing = this.watchers.get(camera.id);
      if (existing) {
        existing.updateSpec(spec);
        continue;
      }
      const watcher = new MotionWatcher(spec, (detection) => this.handleDetection(detection, camera.name));
      watcher.start();
      this.watchers.set(camera.id, watcher);
    }
  }

  stopAll(): void {
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
  }

  status(): MotionManagerStatus {
    const settings = motionSettings();
    return {
      enabled: settings.enabled,
      sampleFps: settings.sampleFps,
      threshold: settings.threshold,
      cooldownMs: settings.cooldownMs,
      snapshotWidth: settings.snapshotWidth,
      cameras: [...this.watchers.values()].map((watcher) => watcher.status()),
    };
  }

  private handleDetection(detection: MotionDetection, cameraName: string): void {
    const event: AgentEvent = {
      type: "agent:event",
      cameraId: detection.cameraId,
      event: "motion",
      score: Number(detection.score.toFixed(4)),
      at: detection.at,
      jpegBase64: detection.jpeg ? detection.jpeg.toString("base64") : undefined,
    };

    const image = detection.jpeg ? `${detection.jpeg.length} B` : "sin imagen";
    console.log(`[motion] 🚨 ${cameraName} score=${detection.score.toFixed(3)} (${image})`);

    if (!this.emit?.(event)) console.warn(`[motion] aviso de ${cameraName} no enviado: sin conexión al server`);

    // F7: el clip empieza aquí (la foto del evento cubre el instante exacto)
    this.clips?.record(detection.cameraId, "motion");
  }
}
