import { describe, expect, it } from 'vitest';
import { EMPTY_STATE, parseState, pickNext, simulate, type Candidate, type DistRules } from '../../src/modules/queues/distribution';
import { startOfLocalDay } from '../../src/modules/queues/local-day';

const c = (userId: string, over: Partial<Candidate> = {}): Candidate => ({ userId, weight: 1, todayCount: 0, openCount: 0, ...over });
const rules = (over: Partial<DistRules> = {}): DistRules => ({ mode: 'equal', batch: 1, dailyCap: 0, ...over });
const seq = (cands: Candidate[], r: DistRules, n: number): string => simulate(cands, r, n).sequence.join('');

describe('reparto · rotación (equal)', () => {
  it('rota por el orden de la cola y da la vuelta', () => {
    expect(seq([c('A'), c('B'), c('C')], rules(), 7)).toBe('ABCABCA');
  });

  it('con «leads seguidos» cada asesor recibe el lote completo antes de pasar al siguiente', () => {
    expect(seq([c('A'), c('B'), c('C')], rules({ batch: 3 }), 10)).toBe('AAABBBCCCA');
    expect(seq([c('A'), c('B')], rules({ batch: 2 }), 6)).toBe('AABBAA');
  });

  it('con un solo asesor, todo va a él', () => {
    expect(seq([c('A')], rules({ batch: 2 }), 4)).toBe('AAAA');
  });

  it('sin candidatos no hay a quién asignar y el estado no cambia', () => {
    const state = { last: 'A', streak: 1, current: {} };
    expect(pickNext([], rules(), state)).toEqual({ userId: null, state });
  });

  it('si el último ya no está en la cola, la rotación empieza de nuevo por el primero; si solo está inhabilitado (tope), sigue con el que le toca', () => {
    // B recibió y salió de la cola: no hay dónde ubicarlo, se empieza por el primero
    expect(pickNext([c('A'), c('C')], rules(), { last: 'B', streak: 1, current: {} }).userId).toBe('A');
    // B sigue en la cola pero llegó a su tope: sigue C, el que le toca después
    expect(pickNext([c('A'), c('B', { todayCount: 5 }), c('C')], rules({ dailyCap: 5 }), { last: 'B', streak: 1, current: {} }).userId).toBe('C');
    // si el último era el final del orden, da la vuelta
    expect(pickNext([c('A'), c('B', { todayCount: 5 })], rules({ dailyCap: 5 }), { last: 'B', streak: 1, current: {} }).userId).toBe('A');
  });

  it('un asesor nuevo entra al final de la rotación sin alterar el turno actual', () => {
    const state = pickNext([c('A'), c('B')], rules(), EMPTY_STATE).state; // A recibió
    expect(pickNext([c('A'), c('B'), c('N')], rules(), state).userId).toBe('B');
  });
});

describe('reparto · tope diario', () => {
  it('quien llegó al tope deja de recibir y los demás siguen; cuando todos llegan, nadie', () => {
    const cands = [c('A', { todayCount: 2 }), c('B', { todayCount: 0 }), c('C', { todayCount: 1 })];
    expect(seq(cands, rules({ dailyCap: 2 }), 10)).toBe('BCB'); // A ya estaba en 2; B llega a 2 con dos y C con una
    expect(pickNext([c('A', { todayCount: 2 }), c('B', { todayCount: 2 })], rules({ dailyCap: 2 }), EMPTY_STATE).userId).toBeNull();
  });

  it('0 es «sin tope»', () => {
    expect(seq([c('A', { todayCount: 999 })], rules({ dailyCap: 0 }), 3)).toBe('AAA');
  });

  it('si el asesor está a mitad de su lote y llega al tope, pasa al siguiente', () => {
    const s = simulate([c('A', { todayCount: 1 }), c('B')], rules({ batch: 3, dailyCap: 2 }), 5);
    expect(s.sequence.join('')).toBe('ABB'); // A recibe 1 y toca su tope; B recibe 2 y también; ya nadie puede
    expect(s.counts).toEqual({ A: 1, B: 2 });
  });
});

describe('reparto · ponderado suave (weighted)', () => {
  it('reparte según el peso y lo mezcla a lo largo del ciclo, no todo de golpe (5:1:1 → AABACAA)', () => {
    expect(seq([c('A', { weight: 5 }), c('B'), c('C')], rules({ mode: 'weighted' }), 7)).toBe('AABACAA');
  });

  it('con pesos iguales es una rotación', () => {
    expect(seq([c('A'), c('B'), c('C')], rules({ mode: 'weighted' }), 6)).toBe('ABCABC');
  });

  it('a la larga cada asesor recibe en proporción a su peso', () => {
    const s = simulate([c('A', { weight: 3 }), c('B', { weight: 2 }), c('C', { weight: 1 })], rules({ mode: 'weighted' }), 60);
    expect(s.counts).toEqual({ A: 30, B: 20, C: 10 });
  });

  it('con lote, cada elegido recibe sus seguidas y el ciclo conserva la proporción (2:1 → AABBAA)', () => {
    expect(seq([c('A', { weight: 2 }), c('B')], rules({ mode: 'weighted', batch: 2 }), 12)).toBe('AABBAA'.repeat(2));
  });

  it('quien llegó al tope pierde sus créditos y no distorsiona el reparto de los demás', () => {
    const s = simulate([c('A', { weight: 10, todayCount: 1 }), c('B'), c('C')], rules({ mode: 'weighted', dailyCap: 1 }), 6);
    expect(s.counts).toEqual({ A: 0, B: 1, C: 1 }); // los tres están en el tope o lo alcanzan con una
    expect(s.sequence.join('')).toBe('BC');
  });
});

describe('reparto · menos conversaciones abiertas (load)', () => {
  it('asigna a quien tenga menos y, entre iguales, al que sigue en la rotación', () => {
    const cands = [c('A', { openCount: 3 }), c('B', { openCount: 1 }), c('C', { openCount: 1 })];
    expect(seq(cands, rules({ mode: 'load' }), 6)).toBe('BCBCAB');
  });

  it('no usa «leads seguidos»', () => {
    const cands = [c('A', { openCount: 3 }), c('B', { openCount: 1 }), c('C', { openCount: 1 })];
    expect(seq(cands, rules({ mode: 'load', batch: 5 }), 6)).toBe('BCBCAB');
  });

  it('respeta el tope diario', () => {
    const cands = [c('A', { openCount: 0, todayCount: 1 }), c('B', { openCount: 9 })];
    expect(seq(cands, rules({ mode: 'load', dailyCap: 1 }), 3)).toBe('B'); // A ya está en su tope; B recibe la primera y llega al suyo
  });
});

describe('estado del reparto', () => {
  it('es una función pura: no modifica sus entradas', () => {
    const cands = [c('A'), c('B')];
    const state = Object.freeze({ last: 'A', streak: 1, current: Object.freeze({ A: 2 }) });
    const before = JSON.stringify([cands, state]);
    pickNext(cands, rules({ mode: 'weighted' }), state);
    simulate(cands, rules(), 5, state);
    expect(JSON.stringify([cands, state])).toBe(before);
  });

  it('un estado guardado dañado o de otra forma equivale a empezar de cero', () => {
    for (const bad of [null, undefined, 42, 'x', [], { last: 5, streak: -1, current: 'no' }, { current: { A: 'x', B: NaN } }]) {
      expect(parseState(bad), JSON.stringify(bad)).toEqual(EMPTY_STATE);
    }
    expect(parseState({ last: 'A', streak: 2, current: { A: -3, B: 1, C: 'x' } })).toEqual({ last: 'A', streak: 2, current: { A: -3, B: 1 } });
  });

  it('ir y volver por el estado guardado da el mismo reparto que seguir en memoria', () => {
    const cands = [c('A', { weight: 3 }), c('B'), c('C', { weight: 2 })];
    const r = rules({ mode: 'weighted', batch: 2 });
    let mem = EMPTY_STATE;
    let stored = EMPTY_STATE;
    for (let i = 0; i < 20; i++) {
      const a = pickNext(cands, r, mem);
      const b = pickNext(cands, r, stored);
      expect(b.userId).toBe(a.userId);
      mem = a.state;
      stored = parseState(JSON.parse(JSON.stringify(b.state)));
    }
  });
});

describe('simulación', () => {
  it('suma cada asignación a la carga y al tope, se detiene cuando nadie puede recibir y no toca los candidatos', () => {
    const cands = [c('A', { todayCount: 0 }), c('B', { todayCount: 0 })];
    const s = simulate(cands, rules({ dailyCap: 2 }), 10);
    expect(s.sequence.join('')).toBe('ABAB');
    expect(cands.map((x) => x.todayCount)).toEqual([0, 0]);
    expect(simulate([], rules(), 5)).toEqual({ sequence: [], counts: {} });
  });
});

describe('inicio del día en la zona horaria de la empresa', () => {
  const at = (iso: string, zone: string): string => startOfLocalDay(new Date(iso), zone).toISOString();

  it('Guayaquil (UTC−5, sin horario de verano): el día empieza a las 05:00 UTC', () => {
    expect(at('2026-10-19T03:00:00Z', 'America/Guayaquil')).toBe('2026-10-18T05:00:00.000Z'); // 22:00 del 18
    expect(at('2026-10-19T04:59:59Z', 'America/Guayaquil')).toBe('2026-10-18T05:00:00.000Z');
    expect(at('2026-10-19T05:00:00Z', 'America/Guayaquil')).toBe('2026-10-19T05:00:00.000Z'); // la medianoche exacta ya es el día nuevo
    expect(at('2026-10-19T22:30:00Z', 'America/Guayaquil')).toBe('2026-10-19T05:00:00.000Z');
  });

  it('UTC, y una zona con media hora de desfase (Kolkata, UTC+5:30)', () => {
    expect(at('2026-10-19T17:45:12Z', 'UTC')).toBe('2026-10-19T00:00:00.000Z');
    expect(at('2026-10-19T20:00:00Z', 'Asia/Kolkata')).toBe('2026-10-19T18:30:00.000Z'); // ya es el 20 allá
  });

  it('con cambio de horario (Nueva York): la medianoche usa el desfase de ESE instante, no el de ahora', () => {
    expect(at('2026-11-01T12:00:00Z', 'America/New_York')).toBe('2026-11-01T04:00:00.000Z'); // el día del cambio de otoño empezó en EDT (UTC−4)
    expect(at('2026-11-02T12:00:00Z', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z'); // al día siguiente ya es EST (UTC−5)
    expect(at('2026-03-08T12:00:00Z', 'America/New_York')).toBe('2026-03-08T05:00:00.000Z'); // el día del cambio de primavera empezó en EST
  });
});
