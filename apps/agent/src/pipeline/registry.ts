import type { Camera } from "@cameras/protocol";
import { MjpegPipeline, type PipelineStatus } from "./mjpeg";
import type { SourceSpec } from "./args";
import type { EncodingStore } from "./encoding";

/** Cámara tal y como la entrega el server al agent (incluye la URL de conexión). */
export interface AgentCamera extends Camera {
  connection: string;
}

/**
 * Conjunto de pipelines activos. Sincronizado con el server (`/api/agent/cameras`).
 * Una cámara eliminada o desactivada se apaga y se descarta.
 */
export class PipelineRegistry {
  private pipelines = new Map<string, MjpegPipeline>();
  private cameras: AgentCamera[] = [];

  constructor(private readonly encoding?: EncodingStore) {}

  sync(cameras: AgentCamera[]): void {
    this.cameras = cameras;
    const wanted = new Set(cameras.filter((c) => c.active).map((c) => c.id));

    // eliminar las que ya no existen
    for (const [id, pipeline] of this.pipelines) {
      if (!wanted.has(id)) {
        pipeline.stop();
        this.pipelines.delete(id);
      }
    }

    for (const camera of cameras) {
      if (!camera.active) continue;
      const stored = this.encoding?.get(camera.id);
      const spec: SourceSpec = {
        cameraId: camera.id,
        sourceType: camera.sourceType,
        connection: camera.connection,
        ...(stored ? { width: stored.width, fps: stored.fps } : {}),
      };
      const existing = this.pipelines.get(camera.id);
      if (existing) {
        existing.updateSpec(spec);
      } else {
        this.pipelines.set(camera.id, new MjpegPipeline(spec));
      }
    }
  }

  /**
   * Aplica una codificación elegida por el admin: se guarda (sobrevive
   * reinicios) y reinicia el FFmpeg en caliente si estaba en marcha. Si la
   * cámara aún no tiene pipeline, el valor queda pendiente y `sync()` lo
   * aplica al crearlo. false = cámara desconocida.
   */
  setEncoding(cameraId: string, encoding: { width: number; fps: number }): boolean {
    const stored = this.encoding?.set(cameraId, encoding) ?? encoding;
    const pipeline = this.pipelines.get(cameraId);
    if (pipeline) {
      pipeline.applyEncoding(stored);
      return true;
    }
    return this.cameras.some((c) => c.id === cameraId && c.active);
  }

  get(cameraId: string): MjpegPipeline | undefined {
    return this.pipelines.get(cameraId);
  }

  all(): MjpegPipeline[] {
    return [...this.pipelines.values()];
  }

  listCameras(): AgentCamera[] {
    return this.cameras;
  }

  statuses(): PipelineStatus[] {
    return this.all().map((p) => p.status());
  }

  stopAll(): void {
    for (const pipeline of this.pipelines.values()) pipeline.stop();
    this.pipelines.clear();
  }
}
