import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeEncoding } from "./args";

export interface StoredEncoding {
  width: number;
  fps: number;
}

const FILE = "encoding.json";

/**
 * Codificación elegida por el administrador (resolución/FPS por cámara).
 *
 * Persiste en `${AGENT_DATA_DIR}/encoding.json` para sobrevivir reinicios del
 * agent; el server la cambia con `server:setEncoding` y la lee de vuelta en
 * los reportes de estado (`GET /api/v1/cameras/:id/encoding`).
 */
export class EncodingStore {
  private readonly file: string;
  private readonly encodings = new Map<string, StoredEncoding>();

  constructor(dataDir: string) {
    const dir = join(dataDir);
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      // Sin disco escribible se sigue en memoria (se pierde al reiniciar).
    }
    this.file = join(dir, FILE);
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      for (const [cameraId, value] of Object.entries(raw ?? {})) {
        if (value && typeof value === "object") {
          this.encodings.set(cameraId, sanitizeEncoding(value as { width?: unknown; fps?: unknown }));
        }
      }
    } catch {
      // Sin archivo previo: se parte de los valores por defecto.
    }
  }

  get(cameraId: string): StoredEncoding | undefined {
    return this.encodings.get(cameraId);
  }

  set(cameraId: string, input: { width?: unknown; fps?: unknown }): StoredEncoding {
    const encoding = sanitizeEncoding(input);
    this.encodings.set(cameraId, encoding);
    try {
      writeFileSync(
        this.file,
        JSON.stringify(Object.fromEntries(this.encodings), null, 2)
      );
    } catch {
      // Fallo de disco: el valor en memoria sigue valiendo en caliente.
    }
    return encoding;
  }
}
