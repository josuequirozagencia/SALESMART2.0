import { describe, expect, it } from 'vitest';
import { byPerson, kindOf } from '../../src/modules/inbox/assignment-steps';

describe('qué fue cada cambio de asesor', () => {
  const c = (from: string | null, to: string | null, actorId: string | null, source = 'manual') => ({ from, to, actorId, source });
  it('clasifica reparto, reasignación, toma, asignación, transferencia y liberación', () => {
    expect(kindOf(c(null, 'a', 'adm', 'automation'))).toBe('distribution');
    expect(kindOf(c(null, 'a', null, 'api'))).toBe('distribution');
    expect(kindOf(c('a', 'b', null, 'automation'))).toBe('reassigned');
    expect(kindOf(c(null, 'a', 'a'))).toBe('taken');
    expect(kindOf(c(null, 'a', 'adm'))).toBe('assigned');
    expect(kindOf(c('a', 'b', 'a'))).toBe('transferred');
    expect(kindOf(c('a', null, 'adm'))).toBe('released');
  });
  it('lo automático no lo pidió ninguna persona', () => {
    expect([byPerson('distribution'), byPerson('reassigned'), byPerson('taken'), byPerson('transferred')]).toEqual([false, false, true, true]);
  });
});
