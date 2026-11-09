import { describe, expect, it } from 'vitest';
import { keyToBytes } from '../src/lib/push';

describe('lib/push', () => {
  it('la clave pública VAPID (base64url) se convierte a bytes', () => {
    const bytes = keyToBytes('AQID-_8'); // 01 02 03 fb ff
    expect([...bytes]).toEqual([1, 2, 3, 251, 255]);
  });
});
