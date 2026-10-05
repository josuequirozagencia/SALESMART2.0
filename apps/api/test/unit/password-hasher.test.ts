import { describe, expect, it } from 'vitest';
import { Argon2idHasher, MAX_PASSWORD_LENGTH } from '../../src/security';

describe('Argon2idHasher', () => {
  const h = new Argon2idHasher();
  it('genera PHC argon2id con los parámetros configurados y verifica', async () => {
    const stored = await h.hash('correct horse battery');
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await h.verify(stored, 'correct horse battery')).toBe(true);
    expect(await h.verify(stored, 'incorrecta')).toBe(false);
    expect(h.needsRehash(stored)).toBe(false);
  });
  it('dos hashes de la misma contraseña difieren (sal única)', async () => {
    expect(await h.hash('x1')).not.toBe(await h.hash('x1'));
  });
  it('hashes corruptos o de otro algoritmo nunca autentican (sin lanzar)', async () => {
    expect(await h.verify('$argon2id$basura', 'x')).toBe(false);
    expect(await h.verify('$2b$10$abcdefghijklmnopqrstuv', 'x')).toBe(false);
    expect(await h.verify('', 'x')).toBe(false);
  });
  it('rechaza contraseñas vacías o gigantes', async () => {
    await expect(h.hash('')).rejects.toThrow();
    await expect(h.hash('a'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow();
    expect(await h.verify(await h.hash('ok'), 'a'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(false);
  });
  it('needsRehash detecta parámetros más débiles que los vigentes', async () => {
    const weak = await new Argon2idHasher({ memoryCost: 8192, timeCost: 1, parallelism: 1 }).hash('pw');
    expect(h.needsRehash(weak)).toBe(true);
    expect(h.needsRehash('$argon2i$v=19$m=1,t=1,p=1$x$y')).toBe(true);
  });
});
