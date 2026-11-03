import { inflateRawSync } from 'node:zlib';
import { crc32Final, crc32Update, CRC32_START } from '../../src/modules/company-export/zip';

/**
 * Lector de ZIP MÍNIMO para las pruebas (F3b): recorre el directorio central, descomprime cada entrada y VERIFICA su CRC y su tamaño. Si el escritor produce algo que un lector estricto
 * rechazaría, esto lo detecta. No es código de producción.
 */
export interface ZipItem {
  name: string;
  data: Buffer;
}

export function readZip(zip: Buffer): ZipItem[] {
  // Fin del directorio central (sin comentario: 22 bytes desde el final)
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error('no hay fin de directorio central');
  const count = zip.readUInt16LE(eocd + 10);
  const dirSize = zip.readUInt32LE(eocd + 12);
  const dirStart = zip.readUInt32LE(eocd + 16);
  if (dirStart + dirSize !== eocd) throw new Error('el directorio central no cuadra');
  const out: ZipItem[] = [];
  let p = dirStart;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('registro central inválido');
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if ((flags & 0x0800) === 0) throw new Error('el nombre no está marcado como UTF-8');
    if (method !== 8) throw new Error('método de compresión inesperado');
    // Cabecera local
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error('cabecera local inválida');
    const lname = zip.readUInt16LE(offset + 26);
    const lextra = zip.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + lname + lextra;
    const data = inflateRawSync(zip.subarray(dataStart, dataStart + csize));
    if (data.length !== size) throw new Error(`tamaño distinto en ${name}`);
    if (crc32Final(crc32Update(CRC32_START, data)) !== crc) throw new Error(`CRC distinto en ${name}`);
    // Descriptor de datos justo después de los datos
    const dd = dataStart + csize;
    if (zip.readUInt32LE(dd) !== 0x08074b50 || zip.readUInt32LE(dd + 4) !== crc || zip.readUInt32LE(dd + 8) !== csize || zip.readUInt32LE(dd + 12) !== size) throw new Error(`descriptor inválido en ${name}`);
    out.push({ name, data });
    p += 46 + nameLen;
  }
  return out;
}
