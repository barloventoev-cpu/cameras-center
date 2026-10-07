import type { FrameHeader } from "@cameras/protocol";

export interface CachedFrame {
  header: FrameHeader;
  data: Buffer;
  receivedAt: number;
}

/**
 * Último frame recibido de cada cámara.
 *
 * No es vídeo: es un caché de UNA imagen JPEG para
 *   - `GET /api/v1/cameras/:id/frame.jpg` (API pública / fallback sin WS)
 *   - miniaturas y tests
 * El video en vivo pasa por el relay WS y no se almacena nunca aquí.
 */
class FrameCache {
  private frames = new Map<string, CachedFrame>();
  private listeners = new Map<string, Set<(frame: CachedFrame) => void>>();
  /** Máx. cámaras cacheadas (una foto por cámara, ~100 KB c/u). */
  private limit = 64;

  set(cameraId: string, header: FrameHeader, data: Buffer): void {
    if (this.frames.size >= this.limit && !this.frames.has(cameraId)) {
      // descartar la más vieja
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, frame] of this.frames) {
        if (frame.receivedAt < oldest) {
          oldest = frame.receivedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) this.frames.delete(oldestKey);
    }
    const frame: CachedFrame = { header, data, receivedAt: Date.now() };
    this.frames.set(cameraId, frame);
    this.notify(cameraId, frame);
  }

  /**
   * Suscripción en vivo a los frames de una cámara (F5: sirve el endpoint
   * MJPEG `GET /api/v1/streams/:id.mjpg`). Devuelve la función de baja.
   */
  on(cameraId: string, listener: (frame: CachedFrame) => void): () => void {
    let set = this.listeners.get(cameraId);
    if (!set) {
      set = new Set();
      this.listeners.set(cameraId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(cameraId);
      current?.delete(listener);
      if (current && current.size === 0) this.listeners.delete(cameraId);
    };
  }

  private notify(cameraId: string, frame: CachedFrame): void {
    const set = this.listeners.get(cameraId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(frame);
      } catch {
        // un suscriptor roto no debe tumbar el relay
      }
    }
  }

  get(cameraId: string): CachedFrame | undefined {
    return this.frames.get(cameraId);
  }

  /** Nº de cámaras con frame cacheado (para el health). */
  size(): number {
    return this.frames.size;
  }

  delete(cameraId: string): void {
    this.frames.delete(cameraId);
  }

  /** ms desde el último frame, o null si no hay. */
  age(cameraId: string): number | null {
    const frame = this.frames.get(cameraId);
    return frame ? Date.now() - frame.receivedAt : null;
  }

  /**
   * Último frame emitido: tamaño real en px y edad. `GET /encoding` lo usa para
   * contrastar lo configurado con lo que de verdad sale del agent: si el FFmpeg
   * en marcha no llegó a reiniciar, el tamaño no cambia aunque el reporte de
   * estado diga lo contrario.
   */
  emitted(cameraId: string): { width: number; height: number; ageMs: number } | null {
    const frame = this.frames.get(cameraId);
    if (!frame) return null;
    const size = jpegSize(frame.data);
    if (!size) return null;
    return { ...size, ageMs: Date.now() - frame.receivedAt };
  }

  /**
   * Antigüedad de todos los frames cacheados: la expone el health para que una
   * integración sepa si cada cámara tiene señal real o es una foto vieja.
   */
  ages(): { cameraId: string; ageMs: number }[] {
    const now = Date.now();
    return [...this.frames.entries()].map(([cameraId, frame]) => ({
      cameraId,
      ageMs: now - frame.receivedAt,
    }));
  }

  clear(): void {
    this.frames.clear();
  }
}

export const frameCache = new FrameCache();

/**
 * Dimensiones (px) de un JPEG leyendo su cabecera SOF; null si no se puede.
 * Es la resolución REAL del fotograma, independientemente de lo configurado.
 */
export function jpegSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i + 1 < data.length) {
    if (data[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = data[i + 1];
    if (marker === undefined || i + 4 > data.length) return null;
    // SOI/EOI/RSTn/TEM: marcos sin longitud que saltar.
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      marker === 0xff ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const len = data.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0..SOF15 salvo DHT (C4), JPG (C8) y DAC (CC): llevan las dimensiones.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > data.length) return null;
      return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
