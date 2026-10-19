import { describe, expect, it } from 'vitest';
import { isUuid, uuidv7 } from '@sales-smart/shared';

const ms = (id: string): number => Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);

describe('uuidv7', () => {
  it('tiene la forma de un UUID v7 (versión 7, variante RFC 9562) y lleva la hora en sus primeros 48 bits', () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
    expect(ms(id)).toBeGreaterThanOrEqual(before);
    expect(ms(id)).toBeLessThanOrEqual(after + 5);
  });

  it('es MONÓTONO: miles de ids seguidos (muchos en el mismo milisegundo) salen en orden estricto de creación, sin repetirse', () => {
    const ids = Array.from({ length: 20_000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids); // el orden por texto (y por bytes en PostgreSQL) es el orden de creación
  });

  it('si el reloj retrocede, el orden se conserva', () => {
    const a = uuidv7();
    const b = uuidv7(Date.now() - 60_000); // un reloj atrasado un minuto
    const c = uuidv7(1);
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
  });

  it('al desbordar el contador de un mismo milisegundo avanza al siguiente y sigue ordenado', () => {
    const t = Date.now() + 10_000_000; // en el futuro: los ids siguientes reutilizan ese milisegundo
    const ids = Array.from({ length: 10_000 }, () => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ms(ids.at(-1)!)).toBeGreaterThan(t); // más de 4096 en un milisegundo obligan a avanzar
  });
});
