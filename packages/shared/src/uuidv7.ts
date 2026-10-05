import { randomFillSync } from 'node:crypto';

/** UUID v7 (RFC 9562): 48 bits de milisegundos Unix + aleatorio. Ordenable por tiempo (Build Spec §6). */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  randomFillSync(b);
  b[0] = (now / 2 ** 40) & 0xff;
  b[1] = (now / 2 ** 32) & 0xff;
  b[2] = (now / 2 ** 24) & 0xff;
  b[3] = (now / 2 ** 16) & 0xff;
  b[4] = (now / 2 ** 8) & 0xff;
  b[5] = now & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70; // versión 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC 9562
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
