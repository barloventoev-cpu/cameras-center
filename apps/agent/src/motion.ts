import { spawn, type ChildProcess } from "node:child_process";
import { motionSettings, parseSceneScore, redactSecrets } from "@cameras/core";
import { buildInputArgs, type SourceSpec } from "./pipeline/args";
import { resolveFfmpegPath } from "./pipeline/ffmpeg";
import { splitJpegFrames } from "./pipeline/jpeg";

/**
 * F6 — detección de movimiento en el agent.
 *
 * FFmpeg se lanza UNA vez por cámara (independiente del pipeline de visión)
 * y produce dos salidas del mismo decode, con la MISMA cadena de filtros
 * (`fps=N,scale=<ancho>:-2`) para que la puntuación impresa y la que dispara
 * el umbral se calculen sobre frames idénticos:
 *
 *   1. `null`   → `select='gte(scene,0)',metadata=print` imprime por **stderr**
 *                 `lavfi.scene_score=…` de cada muestra: sirve para observar y
 *                 afinar el umbral (`highScores` cuenta las ≥ umbral);
 *   2. `pipe:1` → `select='gt(scene,<umbral>)'` sólo emite **JPEG** cuando la
 *                 escena cambia: ese frame es exactamente el del aviso y viaja
 *                 al server como snapshot (`jpegFrames` cuenta los emitidos).
 *
 * Así no hace falta decodificar JPEG en Node ni un segundo proceso por cámara,
 * y la imagen del evento es la del instante en que se detectó.
 */

export interface MotionDetection {
  cameraId: string;
  score: number;
  at: number;
  /** JPEG del momento (null si FFmpeg no pudo producirlo). */
  jpeg: Buffer | null;
}

export type MotionState = "stopped" | "starting" | "running" | "restarting" | "error";

export interface MotionStatus {
  cameraId: string;
  state: MotionState;
  enabled: boolean;
  threshold: number;
  scores: number;
  /** Muestras cuya puntuación ≥ umbral (salida 1, stderr). */
  highScores: number;
  maxScore: number;
  lastScore: number | null;
  lastScoreAt: number | null;
  /** JPEG emitidos por la salida 2 (stdout). */
  jpegFrames: number;
  lastJpegAt: number | null;
  lastJpegScore: number | null;
  detections: number;
  suppressed: number;
  lastDetectionAt: number | null;
  lastError?: string;
}

const MAX_FRAME_BUFFER = 8 * 1024 * 1024;

/** Línea de comandos del detector (exportada para las pruebas). */
export function buildMotionArgs(spec: SourceSpec): string[] {
  const { sampleFps, threshold, snapshotWidth } = motionSettings();
  // Las DOS salidas usan la misma escala: así la puntuación que se imprime y
  // la que dispara el umbral se calculan sobre idénticos frames.
  const chain = `fps=${sampleFps},scale=${snapshotWidth}:-2`;
  return [
    "-nostdin",
    ...buildInputArgs(spec, { loglevel: "info" }),
    "-an",
    // (1) puntuación de escena de cada muestra → stderr
    "-map",
    "0:v:0",
    "-vf",
    `${chain},select='gte(scene,0)',metadata=print`,
    "-f",
    "null",
    "-",
    // (2) sólo los frames que superan el umbral → JPEG por stdout
    "-map",
    "0:v:0",
    "-vf",
    `${chain},select='gt(scene,${threshold})'`,
    "-q:v",
    "4",
    "-f",
    "image2pipe",
    "pipe:1",
  ];
}

export class MotionWatcher {
  private proc: ChildProcess | null = null;
  private spec: SourceSpec;
  private state: MotionState = "stopped";
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private lastError?: string;

  private stderrTail = "";
  private frameBuffer: Buffer = Buffer.alloc(0);

  private scores = 0;
  private highScores = 0;
  private maxScore = 0;
  private lastScore: number | null = null;
  private lastScoreAt: number | null = null;
  private jpegFrames = 0;
  private lastJpegAt: number | null = null;
  private lastJpegScore: number | null = null;
  private detections = 0;
  private suppressed = 0;
  private lastDetectionAt: number | null = null;

  constructor(
    spec: SourceSpec,
    private readonly onDetection: (detection: MotionDetection) => void,
  ) {
    this.spec = spec;
  }

  get cameraId(): string {
    return this.spec.cameraId;
  }

  updateSpec(spec: SourceSpec): void {
    const changed = spec.connection !== this.spec.connection || spec.sourceType !== this.spec.sourceType;
    this.spec = spec;
    if (changed && (this.state === "running" || this.state === "starting")) this.restart();
  }

  start(): void {
    if (this.proc || this.state === "starting") return;
    const bin = resolveFfmpegPath();
    if (!bin) {
      this.state = "error";
      this.lastError = "FFmpeg no disponible";
      return;
    }

    const args = buildMotionArgs(this.spec);
    this.state = "starting";
    this.stopped = false;

    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      return;
    }
    this.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => this.onStderr(chunk));

    proc.on("error", (error) => {
      this.lastError = error.message;
      this.cleanup();
      this.scheduleRestart();
    });

    proc.on("close", (code, signal) => {
      if (this.stopped) return;
      this.lastError = `FFmpeg terminó (code=${code ?? "?"} signal=${signal ?? "-"})`;
      this.cleanup();
      this.scheduleRestart();
    });

    console.log(`[motion] ▶ ${this.spec.cameraId} (umbral ${motionSettings().threshold})`);
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.cleanup();
    this.state = "stopped";
    console.log(`[motion] ⏹ ${this.spec.cameraId}`);
  }

  private restart(): void {
    this.stopped = true;
    this.cleanup();
    this.stopped = false;
    this.start();
  }

  private cleanup(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners();
      proc.kill("SIGKILL");
    }
    this.stderrTail = "";
    this.frameBuffer = Buffer.alloc(0);
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.restartAttempts, 6));
    this.restartAttempts += 1;
    this.state = this.restartAttempts > 5 ? "error" : "restarting";
    console.warn(`[motion] ↻ ${this.spec.cameraId} reinicia en ${delay} ms — ${redactSecrets(this.lastError ?? "")}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.proc = null;
      this.start();
    }, delay);
  }

  // -------------------------------------------------------------------------
  // stderr: puntuaciones de escena
  // -------------------------------------------------------------------------

  private onStderr(chunk: Buffer): void {
    this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    if (this.state === "starting") {
      this.state = "running";
      this.restartAttempts = 0;
    }

    const { threshold } = motionSettings();
    const lines = (this.stderrTail.match(/[^\r\n]*[\r\n]/g) ?? []).filter((line) => line.trim().length > 0);
    this.stderrTail = this.stderrTail.slice(lines.join("").length);

    for (const line of lines) {
      const score = parseSceneScore(line);
      if (score === null) continue;
      this.scores += 1;
      this.lastScore = score;
      this.lastScoreAt = Date.now();
      if (score >= threshold) this.highScores += 1;
      if (score > this.maxScore) this.maxScore = score;
    }
  }

  // -------------------------------------------------------------------------
  // stdout: JPEG de los frames que superaron el umbral
  // -------------------------------------------------------------------------

  private onStdout(chunk: Buffer): void {
    if (this.state === "starting") {
      this.state = "running";
      this.restartAttempts = 0;
    }

    const merged = this.frameBuffer.length > 0 ? Buffer.concat([this.frameBuffer, chunk]) : chunk;
    const { frames, rest, overflow } = splitJpegFrames(merged, MAX_FRAME_BUFFER);
    this.frameBuffer = overflow ? Buffer.alloc(0) : rest;

    for (const jpeg of frames) this.handleDetection(jpeg);
  }

  private handleDetection(jpeg: Buffer): void {
    const now = Date.now();
    const { cooldownMs, threshold } = motionSettings();

    // diagnóstico: cuándo llegó el JPEG y qué puntuación llevaba la salida 1
    this.jpegFrames += 1;
    this.lastJpegAt = now;
    this.lastJpegScore = this.lastScore;

    if (this.lastDetectionAt !== null && now - this.lastDetectionAt < cooldownMs) {
      this.suppressed += 1;
      return;
    }

    this.detections += 1;
    this.lastDetectionAt = now;
    const score = this.lastScore !== null && this.lastScore >= threshold ? this.lastScore : threshold;

    this.onDetection({ cameraId: this.spec.cameraId, score, at: now, jpeg });
  }

  status(): MotionStatus {
    const settings = motionSettings();
    return {
      cameraId: this.spec.cameraId,
      state: this.state,
      enabled: settings.enabled,
      threshold: settings.threshold,
      scores: this.scores,
      highScores: this.highScores,
      maxScore: this.maxScore,
      lastScore: this.lastScore,
      lastScoreAt: this.lastScoreAt,
      jpegFrames: this.jpegFrames,
      lastJpegAt: this.lastJpegAt,
      lastJpegScore: this.lastJpegScore,
      detections: this.detections,
      suppressed: this.suppressed,
      lastDetectionAt: this.lastDetectionAt,
      lastError: this.lastError ? redactSecrets(this.lastError) : undefined,
    };
  }
}
