import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';

const srcImage = 'src/webcam_2275475.png';
const publicDir = 'public';

console.log('Generando favicon para Cameras Center...\n');

try {
  // Leer imagen original como buffer
  const original = readFileSync(srcImage);

  console.log('Leyendo archivo original...\n');

  // Generar PNG-32x32
  console.log('Generando PNG-32x32...');
  await sharp(original, { width: 32, height: 32, fit: 'cover' })
    .png()
    .toFile(`${publicDir}/favicon-32x32.png`);
  console.log('   Guardado como favicon-32x32.png\n');

  // Generar PNG-16x16
  console.log('Generando PNG-16x16...');
  await sharp(original, { width: 16, height: 16, fit: 'cover' })
    .png()
    .toFile(`${publicDir}/favicon-16x16.png`);
  console.log('   Guardado como favicon-16x16.png\n');

  // Generar PNG-48x48  
  console.log('Generando PNG-48x48...');
  await sharp(original, { width: 48, height: 48, fit: 'cover' })
    .png()
    .toFile(`${publicDir}/favicon-48x48.png`);
  console.log('   Guardado como favicon-48x48.png\n');

  // Generar PNG-96x96 (Retina)
  console.log('Generando PNG-96x96 (Retina)...');
  await sharp(original, { width: 96, height: 96, fit: 'cover' })
    .png()
    .toFile(`${publicDir}/favicon-96x96.png`);
  console.log('   Guardado como favicon-96x96.png\n');

} catch (error) {
  console.error('Error al generar favicons:', error.message);
  process.exit(1);
}

console.log('\n✅ Completado!');
console.log('\nArchivos creados en public/:');
console.log('  - favicon-32x32.png');
console.log('  - favicon-16x16.png');
console.log('  - favicon-48x48.png');
console.log('  - favicon-96x96.png');
