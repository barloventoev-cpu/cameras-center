import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, promises as fsp, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { clipSettings, parseCloudinaryUrl, uploadVideo } from "@cameras/core";
import type { AgentClipReady } from "@cameras/protocol";
import { config } from "./config";
import { buildInputArgs, type SourceSpec } from "./pipeline/args";
import { resolveFfmpegPath } from "./pipeline/ffmpeg";
import type { AgentCamera } from "./pipeline/registry";

/**
 * F7 — grabación de clips por eventos.
 *
 * Un `ClipManager` guarda la spec de cada cámara (la misma que usa el detector
 * de movimiento) y, cuando le piden un clip, lanza **un FFmpeg propio** con:
 *
 *   - `-c:v copy` para RTSP/ONVIF (H.264 nativo: sin recodificar, casi gratis)
 *   - `libx264` para MJPEG/test (esas fuentes no traen H.264)
 *   - `-t <s>` para que el proceso se muera solo (nada de temporizadores sueltos)
 *   - MP4 **fragmentado** (`+frag_keyframe+empty_moov`) para que el archivo sea
 *     reproducible aunque FFmpeg se caiga a mitad de la grabación
 *
 * Al cerrarse: poda los clips viejos, sube el MP4 a Cloudinary y emite
 * `agent:clipReady` con **sólo la URL** (el socket limita 2 MB por mensaje).
 */

export interface ClipStatus {
  active: Array<{ cameraId: string; startedAt: number; file: string }>;
  recorded: number;
  uploaded: number;
  failures: number;
  lastUrl: string | null;
  lastError: string | null;
}

interface ActiveClip {
  cameraId: string;
  startedAt: number;
  file: string;
  trigger: "motion" | "manual";
  proc: ChildProcess;
  timer: NodeJS.Timeout;
}

/** MP4 a grabar: copia el H.264 cuando existe, recodifica si no. */
export function buildClipArgs(spec: SourceSpec, file: string, durationMs: number): string[] {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const input = buildInputArgs(spec, { loglevel: "warning" });
  const codec =
    spec.sourceType === "rtsp" || spec.sourceType === "onvif"
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p"];

  return [
    "-y",
    ...input,
    "-an",
    ...codec,
    "-t",
    String(seconds),
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    file,
  ];
}

export class ClipManager {
  private specs = new Map<string, SourceSpec>();
  private active = new Map<string, ActiveClip>();
  private emit: ((clip: AgentClipReady) => boolean) | null = null;
  private stats = { recorded: 0, uploaded: 0, failures: 0 };
  private lastUrl: string | null = null;
  private lastError: string | null = null;

  /** Se inyecta cuando el transport al server ya existe. */
  setEmitter(emit: (clip: AgentClipReady) => boolean): void {
    this.emit = emit;
  }

  sync(cameras: AgentCamera[]): void {
    const wanted = new Map<string, SourceSpec>();
    for (const camera of cameras) {
      if (!camera.active) continue;
      wanted.set(camera.id, {
        cameraId: camera.id,
        sourceType: camera.sourceType,
        connection: camera.connection,
      });
    }
    // si alguien está grabando una cámara que ya no existe, no la interrumpimos:
    // el clip es corto y `-t` la cierra solo
    this.specs = wanted;
  }

  status(): ClipStatus {
    return {
      active: [...this.active.values()].map(({ cameraId, startedAt, file }) => ({ cameraId, startedAt, file })),
      recorded: this.stats.recorded,
      uploaded: this.stats.uploaded,
      failures: this.stats.failures,
      lastUrl: this.lastUrl,
      lastError: this.lastError,
    };
  }

  /** Carpeta local de los clips de una cámara (se crea bajo demanda). */
  clipsDir(cameraId: string): string {
    const dir = path.resolve(config.dataDir, "clips", cameraId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Graba un clip. Devuelve false si no se pudo empezar (cámara desconocida,
   * ya había otro clip en marcha, sin FFmpeg…).
   */
  record(cameraId: string, trigger: "motion" | "manual", durationMs?: number): boolean {
    const settings = clipSettings();
    if (trigger === "motion" && !settings.enabled) return false;

    const spec = this.specs.get(cameraId);
    if (!spec) {
      this.lastError = `cámara desconocida (${cameraId})`;
      console.warn(`[clip] ✗ ${this.lastError}`);
      return false;
    }
    if (this.active.has(cameraId)) {
      console.warn(`[clip] … ya hay un clip en marcha de ${cameraId}, se ignora`);
      return false;
    }

    const bin = resolveFfmpegPath();
    if (!bin) {
      this.stats.failures += 1;
      this.lastError = "FFmpeg no disponible";
      console.warn(`[clip] ✗ ${this.lastError}`);
      return false;
    }

    const wanted = Math.min(Math.max(durationMs ?? settings.durationMs, 1000), settings.maxMs);
    const dir = this.clipsDir(cameraId);
    const file = path.join(dir, `${Date.now()}.mp4`);
    const args = buildClipArgs(spec, file, wanted);

    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      this.stats.failures += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[clip] ✗ no se pudo lanzar FFmpeg: ${this.lastError}`);
      return false;
    }

    const startedAt = Date.now();
    let stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-800);
    });

    // Red de seguridad: `-t` cierra el proceso, pero si RTSP se atasca lo
    // matamos para no dejar un FFmpeg huérfano (F6 nos costó encontrarlos).
    const timer = setTimeout(() => {
      if (!proc.killed) {
        console.warn(`[clip] ⏱ ${cameraId} no terminó en ${wanted} ms, se corta`);
        proc.kill();
      }
    }, wanted + 20_000);

    this.active.set(cameraId, { cameraId, startedAt, file, trigger, proc, timer });
    this.stats.recorded += 1;
    console.log(
      `[clip] ⏺ ${cameraId} ${Math.round(wanted / 1000)} s (${trigger}) → ${path.basename(file)}`,
    );

    proc.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[clip] ✗ FFmpeg: ${this.lastError}`);
    });

    proc.on("close", (code) => {
      void this.finalize(cameraId, file, startedAt, wanted, trigger, code, stderrTail);
    });

    return true;
  }

  /** Cierra todos los clips en marcha (apagado limpio del agent). */
  stopAll(): void {
    for (const clip of [...this.active.values()]) {
      clearTimeout(clip.timer);
      if (!clip.proc.killed) clip.proc.kill();
    }
    this.active.clear();
  }

  private async finalize(
    cameraId: string,
    file: string,
    startedAt: number,
    durationMs: number,
    trigger: "motion" | "manual",
    code: number | null,
    stderrTail: string,
  ): Promise<void> {
    const clip = this.active.get(cameraId);
    if (clip) clearTimeout(clip.timer);
    this.active.delete(cameraId);

    let bytes = 0;
    try {
      bytes = statSync(file).size;
    } catch {
      bytes = 0;
    }

    if (code !== 0 || bytes === 0) {
      this.stats.failures += 1;
      this.lastError = code === 0 ? "archivo vacío" : `FFmpeg salió con código ${code}`;
      const detail = stderrTail.trim().split("\n").slice(-1)[0] ?? "";
      console.warn(`[clip] ✗ ${cameraId}: ${this.lastError}${detail ? ` — ${detail}` : ""}`);
      return;
    }

    this.prune(cameraId);

    const creds = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
    if (!creds) {
      this.lastError = "sin CLOUDINARY_URL";
      console.warn(`[clip] ⚠ clip guardado en ${file} pero no hay CLOUDINARY_URL para subirlo`);
      return;
    }

    try {
      const buffer = await fsp.readFile(file);
      const uploaded = await uploadVideo(buffer, creds, {
        folder: "cameras-center/clips",
        publicId: `${cameraId}-${startedAt}`,
      });

      this.stats.uploaded += 1;
      this.lastUrl = uploaded.url;
      this.lastError = null;
      console.log(`[clip] ✅ ${cameraId} ${bytes} B → ${uploaded.url}`);

      const message: AgentClipReady = {
        type: "agent:clipReady",
        cameraId,
        url: uploaded.url,
        durationMs,
        bytes,
        at: startedAt,
        trigger,
        agentId: config.agentId,
      };
      if (!this.emit?.(message)) {
        console.warn(`[clip] aviso de ${cameraId} no enviado: sin conexión al server`);
      }
    } catch (error) {
      this.stats.failures += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[clip] ✗ no se pudo subir ${path.basename(file)}: ${this.lastError}`);
    }
  }

  /** Conserva los `keep` clips más recientes de la cámara. */
  private prune(cameraId: string): void {
    try {
      const dir = path.resolve(config.dataDir, "clips", cameraId);
      const files = readdirSync(dir)
        .filter((name) => name.endsWith(".mp4"))
        .sort(); // los nombres son marcas de tiempo: orden lexicográfico = cronológico
      const { keep } = clipSettings();
      for (const name of files.slice(0, Math.max(0, files.length - keep))) {
        rmSync(path.join(dir, name), { force: true });
      }
    } catch {
      // la poda nunca debe tumbar la grabación
    }
  }
}
