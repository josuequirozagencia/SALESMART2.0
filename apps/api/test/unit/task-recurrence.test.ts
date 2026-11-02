import { describe, expect, it } from 'vitest';
import { nextOccurrence, noticeAt, resolveRule, type RecurrenceRule } from '../../src/modules/contacts/recurrence';

const GYE = 'America/Guayaquil'; // UTC−5 todo el año
const NY = 'America/New_York'; // con cambio de horario

/** Hora de pared de Guayaquil → instante. 2026-11-02 es lunes. */
const gye = (iso: string): Date => new Date(`${iso}-05:00`);
const rule = (over: Partial<RecurrenceRule> & Pick<RecurrenceRule, 'freq'>): RecurrenceRule => ({ interval: 1, weekdays: null, dayOfMonth: null, ends: { kind: 'never' }, ...over });
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const next = (r: RecurrenceRule, prev: string, now: string, count = 1, zone = GYE): string | null => iso(nextOccurrence(r, gye(prev), gye(now), zone, count));

describe('repetición diaria', () => {
  it('la siguiente es el día siguiente a la misma hora; completarla antes de tiempo no la adelanta', () => {
    expect(next(rule({ freq: 'daily' }), '2026-11-02T09:00:00', '2026-11-02T08:00:00')).toBe(gye('2026-11-03T09:00:00').toISOString());
  });
  it('completada con tres días de atraso salta lo vencido: la próxima es la primera posterior a ahora (no tres tareas vencidas)', () => {
    expect(next(rule({ freq: 'daily' }), '2026-11-02T09:00:00', '2026-11-05T12:00:00')).toBe(gye('2026-11-06T09:00:00').toISOString());
  });
  it('«cada 2 días» se mantiene en su cuadrícula aunque se complete tarde', () => {
    const r = rule({ freq: 'daily', interval: 2 });
    expect(next(r, '2026-11-02T09:00:00', '2026-11-02T10:00:00')).toBe(gye('2026-11-04T09:00:00').toISOString());
    expect(next(r, '2026-11-02T09:00:00', '2026-11-04T12:00:00')).toBe(gye('2026-11-06T09:00:00').toISOString());
  });
});

describe('repetición semanal', () => {
  const MWF = rule({ freq: 'weekly', weekdays: [1, 3, 5] });
  it('avanza al siguiente día marcado de la misma semana y, pasado el último, al primero de la semana siguiente', () => {
    expect(next(MWF, '2026-11-02T09:00:00', '2026-11-02T09:30:00')).toBe(gye('2026-11-04T09:00:00').toISOString()); // lunes → miércoles
    expect(next(MWF, '2026-11-06T09:00:00', '2026-11-06T10:00:00')).toBe(gye('2026-11-09T09:00:00').toISOString()); // viernes → lunes
  });
  it('«cada 2 semanas» salta la semana intermedia', () => {
    expect(next(rule({ freq: 'weekly', interval: 2, weekdays: [1] }), '2026-11-02T09:00:00', '2026-11-02T10:00:00')).toBe(gye('2026-11-16T09:00:00').toISOString());
  });
  it('sin días usa el de la ocurrencia anterior', () => {
    expect(next(rule({ freq: 'weekly' }), '2026-11-04T15:30:00', '2026-11-04T16:00:00')).toBe(gye('2026-11-11T15:30:00').toISOString());
  });
  it('si la regla se editó y el día anterior ya no está marcado, sigue con el próximo día marcado', () => {
    expect(next(rule({ freq: 'weekly', weekdays: [1, 5] }), '2026-11-04T09:00:00', '2026-11-04T10:00:00')).toBe(gye('2026-11-06T09:00:00').toISOString()); // miércoles → viernes
  });
  it('una tarea atrasada semanas vuelve a la cuadrícula', () => {
    expect(next(MWF, '2026-11-02T09:00:00', '2026-12-01T12:00:00')).toBe(gye('2026-12-02T09:00:00').toISOString()); // martes 1 dic → miércoles 2
  });
});

describe('repetición mensual', () => {
  it('el día 31 cae en el último día de los meses cortos y vuelve al 31 cuando existe', () => {
    const r = rule({ freq: 'monthly', dayOfMonth: 31 });
    expect(next(r, '2026-01-31T10:00:00', '2026-01-31T11:00:00')).toBe(gye('2026-02-28T10:00:00').toISOString());
    expect(next(r, '2026-02-28T10:00:00', '2026-02-28T11:00:00')).toBe(gye('2026-03-31T10:00:00').toISOString());
    expect(next(r, '2028-01-31T10:00:00', '2028-01-31T11:00:00')).toBe(gye('2028-02-29T10:00:00').toISOString()); // bisiesto
  });
  it('«cada 3 meses» cruza el año', () => {
    expect(next(rule({ freq: 'monthly', interval: 3, dayOfMonth: 15 }), '2026-11-15T09:00:00', '2026-11-15T10:00:00')).toBe(gye('2027-02-15T09:00:00').toISOString());
  });
  it('completada antes de tiempo, la siguiente es la del mes que viene, no la de este', () => {
    expect(next(rule({ freq: 'monthly', dayOfMonth: 31 }), '2026-03-31T10:00:00', '2026-03-05T08:00:00')).toBe(gye('2026-04-30T10:00:00').toISOString());
  });
});

describe('fin de la serie', () => {
  it('«tras N veces»: la que lleva N ocurrencias ya no crea otra', () => {
    const r = rule({ freq: 'daily', ends: { kind: 'after', count: 3 } });
    expect(next(r, '2026-11-02T09:00:00', '2026-11-02T10:00:00', 2)).not.toBeNull();
    expect(next(r, '2026-11-02T09:00:00', '2026-11-02T10:00:00', 3)).toBeNull();
  });
  it('«hasta una fecha»: la última es la que cae ese día o antes', () => {
    const r = rule({ freq: 'daily', ends: { kind: 'on', date: '2026-11-03' } });
    expect(next(r, '2026-11-02T09:00:00', '2026-11-02T10:00:00')).toBe(gye('2026-11-03T09:00:00').toISOString());
    expect(next(r, '2026-11-03T09:00:00', '2026-11-03T10:00:00')).toBeNull();
  });
});

describe('zona horaria', () => {
  it('la hora de pared se mantiene en el cambio de horario (9:00 de Nueva York antes y después del 8 de marzo)', () => {
    const prev = new Date('2026-03-07T14:00:00Z'); // 09:00 EST
    expect(iso(nextOccurrence(rule({ freq: 'daily' }), prev, new Date('2026-03-07T15:00:00Z'), NY, 1))).toBe('2026-03-08T13:00:00.000Z'); // 09:00 EDT
  });
  it('el día de la semana y el fin de mes se miden en la zona de la empresa, no en UTC', () => {
    // 21:00 del lunes en Guayaquil ya es martes en UTC
    expect(next(rule({ freq: 'weekly', weekdays: [1] }), '2026-11-02T21:00:00', '2026-11-02T22:00:00')).toBe(gye('2026-11-09T21:00:00').toISOString());
  });
});

describe('resolveRule', () => {
  it('la semanal sin días toma el del vencimiento y la mensual, su día del mes (en la zona de la empresa)', () => {
    const due = gye('2026-11-04T21:00:00'); // miércoles 4 en Guayaquil (jueves 5 en UTC)
    expect(resolveRule({ freq: 'weekly', interval: 1, ends: { kind: 'never' } }, due, GYE).weekdays).toEqual([3]);
    expect(resolveRule({ freq: 'monthly', interval: 1, ends: { kind: 'never' } }, due, GYE).dayOfMonth).toBe(4);
  });
  it('ordena y quita repetidos los días', () => {
    expect(resolveRule({ freq: 'weekly', interval: 1, weekdays: [5, 1, 5, 3], ends: { kind: 'never' } }, gye('2026-11-02T09:00:00'), GYE).weekdays).toEqual([1, 3, 5]);
  });
  it('diaria no lleva días ni día del mes', () => {
    const r = resolveRule({ freq: 'daily', interval: 2, weekdays: [1], ends: { kind: 'never' } }, gye('2026-11-02T09:00:00'), GYE);
    expect(r.weekdays).toBeNull();
    expect(r.dayOfMonth).toBeNull();
  });
});

describe('noticeAt (cuándo avisar)', () => {
  const now = gye('2026-11-02T08:00:00');
  it('sin vencimiento no hay aviso', () => expect(noticeAt(null, null, now)).toBeNull());
  it('por omisión, al vencer', () => expect(iso(noticeAt(gye('2026-11-02T09:00:00'), null, now))).toBe(gye('2026-11-02T09:00:00').toISOString()));
  it('con anticipo, antes del vencimiento', () => expect(iso(noticeAt(gye('2026-11-02T10:00:00'), 60, now))).toBe(gye('2026-11-02T09:00:00').toISOString()));
  it('si ese momento ya pasó, no se avisa (no se avisa de lo ya vencido)', () => {
    expect(noticeAt(gye('2026-11-02T07:00:00'), null, now)).toBeNull();
    expect(noticeAt(gye('2026-11-02T08:30:00'), 60, now)).toBeNull();
  });
});
