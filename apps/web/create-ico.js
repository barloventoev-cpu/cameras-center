import { readFileSync, writeFileSync } from 'fs';

const publicDir = 'public';

console.log('Creando favicon.ico multipunto...\n');

// Leer PNGs (cada uno ya tiene su own metadata y PNG header embedded)
try {
  const png16 = readFileSync(`${publicDir}/favicon-16x16.png`);
  const png32 = readFileSync(`${publicDir}/favicon-32x32.png`);
  const png48 = readFileSync(`${publicDir}/favicon-48x48.png`);

  // Padding de datos para múltiplo de 4 bytes desde el inicio de entry (width+height) 
  const padPNG = (buf) => {
    const remainder = buf.length % 4;
    if (remainder) return Buffer.concat([buf, Buffer.alloc(4 - remainder)]);
    return buf;
  };

  // Preparar datos con padding (los PNGs incluyen sus propios headers y son self-contained)
  const d16 = padPNG(png16);       // data for 16x16
  const d32 = padPNG(png32);
  const d48 = padPNG(png48);

  // offsets absolutos (desde el final de header + first entry)
  let offset16 = 20;              // First entry at offset 20 from start
  let offset32 = offset16 + d16.length;
  let offset48 = offset32 + d32.length;

  // ICO Header (14 bytes): count, reserved?, first dims
  const headerSize = 14;
  const firstImageWidth = Math.min(16, PNG_16);    // First entry must use smallest? Actually any order works. Order doesn't matter!
  
  // Write ICO file:
  // Header: [count:2] [reserved=0:2? or width/height?] [width first:2] [height first:2]
  // Entries each have their own dimensions + PNG data offsets
  
  const ICO_Header = Buffer.alloc(headerSize);
  
  // Count (uint16 LE at offset 0): total images
  ICO_Header.writeUInt16LE(3, 0);           // count=3 (three images in file)
   
} catch (error) {
  console.error('❌ Error creando favicon.ico:', error.message);
  process.exit(1);
}
