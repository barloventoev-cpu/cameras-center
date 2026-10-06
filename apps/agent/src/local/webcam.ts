import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../config";
import { splitJpegFrames } from "../pipeline/jpeg";
import { resolveFfmpegPath } from "../pipeline/ffmpeg";

/**
 * F9 — webcam local (V4L2) publicada como MJPEG por el propio agent.
 *
 * El problema: V4L2 da el dispositivo a **un solo proceso**, y en el agent hay
 * dos consumidores independientes por cámara activa —el pipeline de visión y el
 * detector de movimiento (F6)—, así que si cada uno abría `/dev/video0`
 * resultaba en `Device or resource busy` y nadie llegaba a ver nada.
 *
 * La solución es la de cualquier cámara IP: **un único dueño** captura y
 * reparte. Aquí ese dueño es este módulo:
 *
 *   FFmpeg (-f v4l2) ──frames──► WebcamCapture ──► N clientes HTTP (MJPEG)
 *                                    ▲                   │
 *                        pipeline de visión ◄────────────┤  (loopback)
 *                        detector de movimiento ◄────────┘
 *
 * El primer cliente arranca el FFmpeg; el último lo deja en marcha unos
 * segundos y después se apaga (sin espectadores, la cámara no tiene por qué
 * estar encendida). Si el dispositivo está ocupado por otra aplicación (una
 * videollamada, p. ej.) se reintenta con espera, sin martillear.
 *
 * El servicio se expone **sólo en loopback**: una webcam integrada tiene más
 * privacidad que una cámara IP; desde la LAN se ve a través de la app.
 */
export interface WebcamStatus {
  device: string;
  running: boolean;
  clients: number;
  frames: number;
  lastError?: string;
}

/** ms sin clientes antes de apagar la captura. */
const IDLE_STOP_MS = 5_000;
/** ms de espera antes de reintentar si el proceso murió (p. ej. EBUSY). */
const RESTART_DELAY_MS = 2_000;
/** Ancho máximo capturado (si la webcam da más, se recorta). */
const MAX_WIDTH = 1280;

export class WebcamCapture {
  private proc: ChildProcess | null = null;
  private listeners = new Set<(frame: Buffer) => void>();
  private buffer: Buffer = Buffer.alloc(0);
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private latest: Buffer | null = null;
  private frames = 0;
  private lastError?: string;

  constructor(
    readonly device: string,
    private readonly fps: number,
  ) {}

  get clients(): number {
    return this.listeners.size;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** Último frame capturado (para `/webcam.jpg`). */
  snapshot(): Buffer | null {
    return this.latest;
  }

  status(): WebcamStatus {
    return {
      device: this.device,
      running: this.running,
      clients: this.clients,
      frames: this.frames,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /**
   * Da de alta un cliente. El primero arranca el FFmpeg (dueño del
   * dispositivo); devuelve la función de baja, que apaga la captura cuando ya
   * no queda nadie mirando.
   */
  subscribe(listener: (frame: Buffer) => void): () => void {
    this.listeners.add(listener);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // el último frame en cuanto haya: acelera el primer snapshot
    if (this.latest) listener(this.latest);
    this.start();
    return () => {
      this.listeners.delete(listener);
      this.scheduleStop();
    };
  }

  private scheduleStop(): void {
    if (this.listeners.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.listeners.size === 0) this.stop();
    }, IDLE_STOP_MS);
  }

  private start(): void {
    if (this.proc) return;
    if (!existsSync(this.device)) {
      this.fail(`no existe el dispositivo ${this.device}`);
      return;
    }
    const ffmpeg = resolveFfmpegPath();
    if (!ffmpeg) {
      this.fail("no se encontró FFmpeg");
      return;
    }

    const args = [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-f",
      "v4l2",
      "-i",
      this.device,
      "-an",
      "-vf",
      `fps=${this.fps},scale='min(${MAX_WIDTH},iw)':-2`,
      "-q:v",
      "6",
      "-f",
      "mjpeg",
      "pipe:1",
    ];

    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.buffer = Buffer.alloc(0);
    this.lastError = undefined;
    console.log(`[webcam] ▶ ${this.device} @ ${this.fps} fps`);

    proc.stdout?.on("data", (chunk: Buffer) => this.onFrames(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => this.onLog(chunk));
    proc.on("error", (error) => {
      this.fail(`no se pudo lanzar FFmpeg: ${error.message}`);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return; // ya se había parado a mano
      this.proc = null;
      const detail = `code=${code} signal=${signal ?? "-"}`;
      console.warn(`[webcam] ⏹ ${this.device} (${detail})`);
      if (this.listeners.size > 0) this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.listeners.size > 0 && !this.proc) this.start();
    }, RESTART_DELAY_MS);
  }

  private stop(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    proc.stdout?.removeAllListeners("data");
    proc.kill("SIGKILL");
    console.log(`[webcam] ⏹ ${this.device} (sin clientes)`);
  }

  private onFrames(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const result = splitJpegFrames(this.buffer);
    this.buffer = result.rest;
    if (result.overflow) {
      console.warn(`[webcam] buffer desbordado en ${this.device}: se descarta`);
      return;
    }
    for (const frame of result.frames) {
      this.frames += 1;
      this.latest = frame;
      for (const listener of this.listeners) listener(frame);
    }
  }

  private onLog(chunk: Buffer): void {
    const text = chunk.toString("utf8").trim();
    if (!text) return;
    // La causa habitual de fallo es que otra aplicación tenga la cámara:
    // se deja constancia una sola vez y el reintento ya está programado.
    const busy = /busy|Permission denied|Cannot open/i.test(text);
    if (busy && this.lastError) return;
    if (busy) this.lastError = text;
    console.warn(`[webcam] ${text}`);
  }

  private fail(message: string): void {
    this.lastError = message;
    console.warn(`[webcam] ✗ ${this.device}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// API del módulo
// ---------------------------------------------------------------------------

const captures = new Map<string, WebcamCapture>();

/** Ruta canónica del dispositivo: acepta `/dev/video0` o `video0`. */
export function devicePathOf(connection: string): string {
  const raw = (connection ?? "").trim();
  if (!raw) return "/dev/video0";
  if (raw.startsWith("/") || raw.startsWith("\\\\.\\")) return raw;
  if (/^video\d+$/i.test(raw)) return `/dev/${raw.toLowerCase()}`;
  return raw;
}

/**
 * URL MJPEG interna (loopback) que consumen el pipeline de visión, el
 * detector de movimiento y la grabación de clips. `connection` de la cámara
 * es el propio dispositivo (`/dev/video0`), no una URL: la traduce el agent.
 */
export function webcamEndpoint(connection: string): string {
  const device = devicePathOf(connection);
  return `http://127.0.0.1:${config.streamPort}/webcam.mjpg?device=${encodeURIComponent(device)}`;
}

/** Captura del dispositivo (una por dispositivo; se crea al primer uso). */
export function webcamCapture(connection: string): WebcamCapture {
  const device = devicePathOf(connection);
  let capture = captures.get(device);
  if (!capture) {
    capture = new WebcamCapture(device, config.webcamFps);
    captures.set(device, capture);
  }
  return capture;
}

/** Estado de todas las capturas (panel de depuración `/api/webcam`). */
export function webcamStatus(): WebcamStatus[] {
  return [...captures.values()].map((capture) => capture.status());
}
