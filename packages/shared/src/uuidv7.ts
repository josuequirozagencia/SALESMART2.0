import { randomFillSync } from 'node:crypto';

/** Último milisegundo usado y el contador de 12 bits de ese milisegundo (estado del proceso). */
let lastMs = -1;
let seq = 0;

/**
 * UUID v7 (RFC 9562): 48 bits de milisegundos Unix + contador de 12 bits + aleatorio. Ordenable por tiempo (Build Spec §6) y MONÓTONO dentro del proceso
 * (RFC 9562 §6.2, método 1): dos ids creados en el mismo milisegundo salen en el orden de creación, y si el reloj retrocede el orden se conserva. Importa porque
 * varias filas escritas en una misma transacción comparten la hora de la transacción y solo el id las distingue en el orden de creación (p. ej. la auditoría).
 * Entre procesos distintos solo se garantiza el orden por milisegundo.
 */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  randomFillSync(b);
  let ms = now;
  if (ms > lastMs) {
    lastMs = ms;
    seq = ((b[6]! & 0x07) << 8) | b[7]!; // arranque aleatorio de 11 bits: deja 2048 incrementos de margen antes de desbordar
  } else {
    // Mismo milisegundo (o el reloj retrocedió): se sigue el contador; si se desborda, se adelanta un milisegundo
    seq += 1;
    if (seq > 0xfff) {
      lastMs += 1;
      seq = 0;
    }
    ms = lastMs;
  }
  b[0] = (ms / 2 ** 40) & 0xff;
  b[1] = (ms / 2 ** 32) & 0xff;
  b[2] = (ms / 2 ** 24) & 0xff;
  b[3] = (ms / 2 ** 16) & 0xff;
  b[4] = (ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | ((seq >> 8) & 0x0f); // versión 7 + 4 bits altos del contador
  b[7] = seq & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80; // variante RFC 9562
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
