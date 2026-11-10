import { describe, expect, it } from 'vitest';
import { planConnectionMoves, type ConnectionKind, type ConnectionRow } from '../../src/modules/connection-queue';

const Q1 = '11111111-1111-4111-8111-111111111111';
const Q2 = '22222222-2222-4222-8222-222222222222';
const OF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // oficial
const QR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // QR
const QR2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const rows = (...r: Array<[string, 'meta_cloud' | 'evolution', string | null]>): ConnectionRow[] => r.map(([id, provider, queueId]) => ({ id, provider, queueId }));
const want = (...w: Array<[string, ConnectionKind]>): Map<string, ConnectionKind> => new Map(w);
const plan = (o: Partial<Parameters<typeof planConnectionMoves>[0]>) =>
  planConnectionMoves({ queueId: Q1, wanted: want(), rows: [], moveTo: null, allowUnassigned: false, ...o });

describe('planConnectionMoves (v7, ADR-65)', () => {
  it('asigna las nuevas, deja quietas las que ya estaban y no toca a las demás', () => {
    const r = plan({ wanted: want([OF, 'channel'], [QR, 'qr']), rows: rows([OF, 'meta_cloud', null], [QR, 'evolution', Q1]) });
    expect(r.moves).toEqual([{ id: OF, from: null, to: Q1 }]);
    expect(r.leaving).toBe(0);
  });

  it('una pedida que está en otro departamento se mueve aquí', () => {
    expect(plan({ wanted: want([OF, 'channel']), rows: rows([OF, 'meta_cloud', Q2]) }).moves).toEqual([{ id: OF, from: Q2, to: Q1 }]);
  });

  it('las que salen van al destino; sin destino exige confirmación', () => {
    const base = { wanted: want([OF, 'channel']), rows: rows([OF, 'meta_cloud', Q1], [QR, 'evolution', Q1], [QR2, 'evolution', Q1]) };
    const r = plan({ ...base, moveTo: Q2 });
    expect(r.moves).toEqual([{ id: QR, from: Q1, to: Q2 }, { id: QR2, from: Q1, to: Q2 }]);
    expect(r.leaving).toBe(2);
    expect(r.destination).toBe(Q2);
    expect(() => plan(base)).toThrowError(expect.objectContaining({ code: 'DESTINATION_REQUIRED', status: 400 }) as Error);
    const free = plan({ ...base, allowUnassigned: true });
    expect(free.moves).toEqual([{ id: QR, from: Q1, to: null }, { id: QR2, from: Q1, to: null }]);
    expect(free.destination).toBeNull();
  });

  it('el destino no puede ser el mismo departamento', () => {
    expect(() => plan({ rows: rows([QR, 'evolution', Q1]), moveTo: Q1 })).toThrowError(expect.objectContaining({ code: 'DESTINATION_SAME' }) as Error);
  });

  it('sin salidas no hace falta destino (ni se valida)', () => {
    expect(plan({ wanted: want([OF, 'channel']), rows: rows([OF, 'meta_cloud', Q1]), moveTo: Q1 }).moves).toEqual([]);
  });

  it('una conexión pedida que no está en la lista, o de otro tipo, es 404 uniforme', () => {
    expect(() => plan({ wanted: want([OF, 'channel']), rows: [] })).toThrowError(expect.objectContaining({ status: 404 }) as Error);
    expect(() => plan({ wanted: want([OF, 'qr']), rows: rows([OF, 'meta_cloud', null]) })).toThrowError(expect.objectContaining({ status: 404 }) as Error);
    expect(() => plan({ wanted: want([QR, 'channel']), rows: rows([QR, 'evolution', null]) })).toThrowError(expect.objectContaining({ status: 404 }) as Error);
  });

  it('el conjunto vacío saca a todas', () => {
    expect(plan({ rows: rows([OF, 'meta_cloud', Q1]), allowUnassigned: true }).moves).toEqual([{ id: OF, from: Q1, to: null }]);
  });
});
