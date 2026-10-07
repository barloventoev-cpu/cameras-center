import { readFileSync, writeFileSync, existsSync } from 'fs';
import sharp from 'sharp';

const publicDir = 'public';

console.log('Creando favicon.ico multipunto...\n');

// Leer PNGs
const png16 = readFileSync(`${publicDir}/favicon-16x16.png`);
const png32 = readFileSync(`${publicDir}/favicon-32x32.png`);
const png48 = readFileSync(`${publicDir}/favicon-48x48.png`);

if (!png16 || !png32 || !png48) {
  throw new Error('Uno o más PNGs no existen');
}

// Pad de PNG para múltiplo de 4 bytes y con headers PNG
const padPNG = (pngBuffer, width, height) => {
  // Asegurar que PNG tiene suficiente padding entre IHDR y datos
  const paddedSize = Math.ceil(pngBuffer.length / 4) * 4;
  const padding = Buffer.alloc(paddedSize - pngBuffer.length, 0);
  return Buffer.concat([pngBuffer, padding]);
};

// Crear ICO header (14 bytes):
// [count:2] [width=first:2] [height=first:2] [colorPlanes:2] [bitsPerPixel:2] [reserved:4]
const ic0Header = { count: 3, width: 16, height: 16 }; // Usamos first entry dims

// Estructura de entrada (entry) cada una para PNG en archivo:
// Width:4, Height:4, Reserved:8 (must be zeros actually in spec), BitsPerPixel:2
const createEntryHeader = (width, height) => {
  const entrySize = Buffer.alloc(20);
  entrySize.writeUInt32LE(width, 0);            // Offsrt Offset=0: width as uint32 LE
  entrySize.writeUInt32LE(height, 4);           // Height as uint32 LE at offset 4

};

// Datos: PNG data con padding hasta múltiplo de 4 bytes desde inicio del header de entry
const padToMultipleOf4 = (buffer) => {
  const remainder = buffer.length % 4;
  if (remainder !== 0) {
    return Buffer.concat([buffer, Buffer.alloc(4 - remainder, 0)]);
  }
  return buffer;
};

// Calcular offsets relativos para header
const offset16 = padPNG(png16).length + ((padPNG(png32)).length); // Incorrecto cálculo simple

Voy a usar un enfoque más directo escribiendo el .ico con estructura simplificada:
