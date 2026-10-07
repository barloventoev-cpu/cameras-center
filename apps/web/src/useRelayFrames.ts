import { useEffect, useState } from "react";
import { subscribeFrame } from "./relay";

/** Cuántos object URLs vivos mantenemos por cámara (evita parpadeos y GC). */
const POOL_SIZE = 8;

/** Sin frames en vivo en este tiempo, la cámara deja de considerarse "en vivo". */
const STALE_MS = 8000;

/** Cada cuánto se reevalúa la frescura de los frames (ms). */
const TICK_MS = 1000;

/** Estado de la imagen de una cámara del relay. */
export interface RelayFrame {
  /** Última imagen recibida (object URL) lista para un `<img src>`. */
  url?: string;
  /** Instante del último frame EN VIVO. null = sólo llegó la "puesta al día". */
  lastLiveAt: number | null;
  /** true si el último frame vivo es reciente: hay vídeo ahora mismo. */
  live: boolean;
}

/**
 * Recibe frames JPEG del relay del server (F3) y devuelve la última imagen
 * como object URL, lista para un `<img src>`, junto con su frescura.
 *
 * La frescura importa: el server manda al suscribirse la última foto que
 * tiene en caché (seq=-1) y, si el agent se apaga a mitad de visionado, los
 * frames se detienen. Sin este control la tarjeta se quedaría con una imagen
 * congelada y la pastilla «En vivo» puesta (imagen fantasma).
 *
 * Sólo se suscribe a las cámaras de `cameraIds`: al vaciar la lista se manda
 * `viewer:unsubscribe` y el server deja de reenviar.
 */
export function useRelayFrames(cameraIds: string[]): Record<string, RelayFrame> {
  const [frames, setFrames] = useState<Record<string, Pick<RelayFrame, "url" | "lastLiveAt">>>({});
  const [, setTick] = useState(0);
  // clave estable para el efecto (evita re-suscribirse en cada render)
  const key = [...cameraIds].sort().join(",");

  // reloj: hace que `live` pase a false cuando dejan de llegar frames
  useEffect(() => {
    if (!key) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [key]);

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setFrames({});
      return;
    }

    const pools = new Map<string, string[]>();
    const cleanups: Array<() => void> = [];

    for (const cameraId of ids) {
      const pool: string[] = [];
      pools.set(cameraId, pool);

      cleanups.push(
        subscribeFrame(cameraId, (blob, meta) => {
          const objectUrl = URL.createObjectURL(blob);
          pool.push(objectUrl);
          while (pool.length > POOL_SIZE) {
            const old = pool.shift();
            if (old) URL.revokeObjectURL(old);
          }
          setFrames((prev) => {
            const previous = prev[cameraId];
            // seq=-1 es la foto de caché del server: pinta, pero NO cuenta
            // como señal en vivo.
            const lastLiveAt = meta.seq === -1 ? (previous?.lastLiveAt ?? null) : meta.at;
            return { ...prev, [cameraId]: { url: objectUrl, lastLiveAt } };
          });
        }),
      );
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
      for (const pool of pools.values()) {
        for (const objectUrl of pool) URL.revokeObjectURL(objectUrl);
      }
      setFrames({});
    };
  }, [key]);

  // `live` se deriva en cada render (el tick de arriba obliga a repintar)
  const now = Date.now();
  const out: Record<string, RelayFrame> = {};
  for (const [cameraId, frame] of Object.entries(frames)) {
    out[cameraId] = {
      ...frame,
      live: frame.lastLiveAt !== null && now - frame.lastLiveAt <= STALE_MS,
    };
  }
  return out;
}
