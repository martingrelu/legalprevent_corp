// Empaqueta PNG en un .ico (entradas PNG, válido en todos los navegadores actuales).
// Uso: node tools/og/make-ico.mjs salida.ico a-16.png a-32.png a-48.png
import { readFileSync, writeFileSync } from "node:fs";

const [out, ...inputs] = process.argv.slice(2);
const pngs = inputs.map((path) => readFileSync(path));
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach((png, i) => {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const entry = 6 + 16 * i;
  header.writeUInt8(width >= 256 ? 0 : width, entry);
  header.writeUInt8(height >= 256 ? 0 : height, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
writeFileSync(out, Buffer.concat([header, ...pngs]));
