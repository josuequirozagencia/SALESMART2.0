/** Imágenes mínimas armadas a mano para probar el favicon (solo cabeceras válidas: no hace falta que se vean). */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function png(w: number, h: number, padTo = 0): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr[16] = 8; // profundidad
  ihdr[17] = 6; // RGBA
  const b = Buffer.concat([PNG_SIG, ihdr]);
  return padTo > b.length ? Buffer.concat([b, Buffer.alloc(padTo - b.length)]) : b;
}

/** Un ICO con una entrada por cada tamaño dado (0 en el byte = 256). */
export function ico(...sizes: Array<[number, number]>): Buffer {
  const head = Buffer.alloc(6 + sizes.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  const data = Buffer.alloc(16);
  sizes.forEach(([w, h], i) => {
    const at = 6 + i * 16;
    head[at] = w === 256 ? 0 : w;
    head[at + 1] = h === 256 ? 0 : h;
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(head.length, at + 12);
  });
  return Buffer.concat([head, data]);
}

function riff(chunk: string, body: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + 8 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  head.write(chunk, 12, 'latin1');
  head.writeUInt32LE(body.length, 16);
  return Buffer.concat([head, body]);
}

/** WebP con pérdida (VP8): código de inicio y 14 bits de ancho y alto. */
export function webpLossy(w: number, h: number): Buffer {
  const body = Buffer.alloc(10);
  body[3] = 0x9d;
  body[4] = 0x01;
  body[5] = 0x2a;
  body.writeUInt16LE(w, 6);
  body.writeUInt16LE(h, 8);
  return riff('VP8 ', body);
}

/** WebP sin pérdida (VP8L): firma 0x2F y (ancho-1, alto-1) en 14 bits cada uno. */
export function webpLossless(w: number, h: number): Buffer {
  const body = Buffer.alloc(10);
  body[0] = 0x2f;
  body.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
  return riff('VP8L', body);
}

/** WebP extendido (VP8X): ancho-1 y alto-1 de 24 bits. */
export function webpExtended(w: number, h: number): Buffer {
  const body = Buffer.alloc(10);
  body.writeUIntLE(w - 1, 4, 3);
  body.writeUIntLE(h - 1, 7, 3);
  return riff('VP8X', body);
}

export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script></svg>');
