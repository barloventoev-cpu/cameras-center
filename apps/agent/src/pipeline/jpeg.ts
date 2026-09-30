const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

export interface SplitJpegResult {
  /** JPEGs completos, ya separados del resto del stream. */
  frames: Buffer[];
  /** Sobrante: posible cabecera o frame a medio recibir. */
  rest: Buffer;
  /** true si el buffer desbordó (stream corrupto): hay que descartarlo todo. */
  overflow: boolean;
}

/**
 * Separa JPEGs concatenados en un stream (MJPEG por stdout de FFmpeg).
 *
 * Marcador SOI `FF D8 FF` → inicio; EOI `FF D9` → fin. Un chunk puede traer
 * medio frame, ninguno o varios: por eso el resto se conserva para el siguiente.
 */
export function splitJpegFrames(input: Buffer, maxBuffer = DEFAULT_MAX_BUFFER): SplitJpegResult {
  if (input.length > maxBuffer) return { frames: [], rest: Buffer.alloc(0), overflow: true };

  let buffer = input;
  const frames: Buffer[] = [];

  for (;;) {
    const soi = buffer.indexOf(SOI);
    if (soi === -1) {
      // conservar los últimos 2 bytes: podrían ser un SOI partido entre chunks
      const rest = buffer.length <= 2 ? buffer : buffer.subarray(buffer.length - 2);
      return { frames, rest, overflow: false };
    }
    if (soi > 0) buffer = buffer.subarray(soi); // basura antes del SOI

    const eoi = buffer.indexOf(EOI, 3);
    if (eoi === -1) return { frames, rest: buffer, overflow: false };

    frames.push(Buffer.from(buffer.subarray(0, eoi + 2)));
    buffer = buffer.subarray(eoi + 2);

    if (buffer.length > maxBuffer) return { frames, rest: Buffer.alloc(0), overflow: true };
  }
}
