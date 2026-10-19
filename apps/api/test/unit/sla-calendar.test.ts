import { describe, expect, it } from 'vitest';
import { addBusinessMinutes, alwaysOpen, businessSecondsBetween, formatTime, isHoliday, isOpenAt, nextOpenAt, parseTime, parseWeek, weekFromJson, weekHasOpenTime, weekToInput, weekToJson, type Calendar, type Interval, type Week } from '../../src/modules/sla/calendar';
import { addDays, instantAt, isValidTimeZone, localDate, offsetMs, weekdayOf } from '../../src/time/zone';

const GYE = 'America/Guayaquil'; // UTC−5 todo el año
const NY = 'America/New_York'; // con cambio de horario

/** Hora de pared de Guayaquil → instante (UTC−5 fijo). */
const gye = (iso: string): Date => new Date(`${iso}-05:00`);
const hm = (s: number, e: number): Interval => [s, e];
const t = (h: number, m = 0): number => h * 60 + m;

/** Lunes a sábado de 08:30 a 18:00 (el ejemplo del prototipo). */
const MON_SAT: Week = [[], ...Array.from({ length: 6 }, () => [hm(t(8, 30), t(18))])];
const cal = (over: Partial<Calendar> = {}): Calendar => ({ timeZone: GYE, week: MON_SAT, holidays: new Set(), yearly: new Set(), ...over });

describe('zona horaria', () => {
  it('conoce la hora de pared de un instante y su desfase (sin cambio de horario en Guayaquil)', () => {
    expect(isValidTimeZone(GYE)).toBe(true);
    expect(isValidTimeZone('No/Existe')).toBe(false);
    expect(offsetMs(new Date('2025-10-13T12:00:00Z'), GYE)).toBe(-5 * 3_600_000);
    expect(localDate(new Date('2025-10-13T03:30:00Z'), GYE)).toEqual({ y: 2025, m: 10, d: 12, minutes: t(22, 30) }); // todavía es el domingo en Guayaquil
    expect(weekdayOf({ y: 2025, m: 10, d: 12 })).toBe(0);
    expect(addDays({ y: 2025, m: 12, d: 31 }, 1)).toEqual({ y: 2026, m: 1, d: 1 });
    expect(addDays({ y: 2025, m: 3, d: 1 }, -1)).toEqual({ y: 2025, m: 2, d: 28 });
  });

  it('el instante de una hora de pared vuelve a esa hora de pared, también con cambio de horario', () => {
    for (const [zone, day] of [[GYE, { y: 2025, m: 10, d: 13 }], [NY, { y: 2025, m: 3, d: 9 }], [NY, { y: 2025, m: 11, d: 2 }], [NY, { y: 2025, m: 7, d: 4 }]] as const) {
      for (const minute of [0, t(1), t(3), t(8, 30), t(17), t(23, 59)]) {
        const at = instantAt(day, minute, zone);
        expect(localDate(at, zone), `${zone} ${day.m}/${day.d} ${minute}`).toEqual({ ...day, minutes: minute });
      }
    }
    expect(instantAt({ y: 2025, m: 10, d: 13 }, 1440, GYE).toISOString()).toBe('2025-10-14T05:00:00.000Z'); // 1440 = la medianoche siguiente
  });
});

describe('¿está abierto?', () => {
  it('abre y cierra a su hora, cierra el domingo y respeta los feriados (de una fecha y anuales)', () => {
    const c = cal({ holidays: new Set(['2025-10-14']), yearly: new Set(['12-25']) });
    expect(isOpenAt(c, gye('2025-10-13T08:29:00'))).toBe(false);
    expect(isOpenAt(c, gye('2025-10-13T08:30:00'))).toBe(true);
    expect(isOpenAt(c, gye('2025-10-13T17:59:59'))).toBe(true);
    expect(isOpenAt(c, gye('2025-10-13T18:00:00'))).toBe(false);
    expect(isOpenAt(c, gye('2025-10-12T12:00:00'))).toBe(false); // domingo
    expect(isOpenAt(c, gye('2025-10-14T12:00:00'))).toBe(false); // feriado de esa fecha
    expect(isOpenAt(c, gye('2025-10-21T12:00:00'))).toBe(true); // el martes siguiente sí
    expect(isOpenAt(c, gye('2025-12-25T12:00:00'))).toBe(false); // anual
    expect(isOpenAt(c, gye('2026-12-25T12:00:00'))).toBe(false);
    expect(isHoliday(c, { y: 2027, m: 12, d: 25 })).toBe(true);
    expect(isHoliday(c, { y: 2025, m: 10, d: 15 })).toBe(false);
  });

  it('la próxima apertura: ahora mismo si ya está abierto; si no, el siguiente tramo abierto', () => {
    const c = cal({ holidays: new Set(['2025-10-13']) });
    expect(nextOpenAt(c, gye('2025-10-15T10:00:00'))!.toISOString()).toBe(gye('2025-10-15T10:00:00').toISOString());
    expect(nextOpenAt(c, gye('2025-10-11T19:00:00'))!.toISOString()).toBe(gye('2025-10-14T08:30:00').toISOString()); // sábado tarde: domingo cerrado y lunes feriado
    expect(nextOpenAt(c, gye('2025-10-14T06:00:00'))!.toISOString()).toBe(gye('2025-10-14T08:30:00').toISOString());
    expect(nextOpenAt({ ...c, week: Array.from({ length: 7 }, () => []) }, gye('2025-10-15T10:00:00'))).toBeNull();
  });
});

describe('sumar minutos de tiempo abierto (la fecha límite de un SLA)', () => {
  it('dentro del horario es el tiempo corrido', () => {
    expect(addBusinessMinutes(cal(), gye('2025-10-13T09:00:00'), 15).toISOString()).toBe(gye('2025-10-13T09:15:00').toISOString());
    expect(addBusinessMinutes(cal(), gye('2025-10-13T09:00:00'), 0).toISOString()).toBe(gye('2025-10-13T09:00:00').toISOString());
  });

  it('lo que no cabe antes del cierre sigue en la próxima apertura (sábado tarde → lunes temprano)', () => {
    expect(addBusinessMinutes(cal(), gye('2025-10-11T17:50:00'), 15).toISOString()).toBe(gye('2025-10-13T08:35:00').toISOString());
    expect(addBusinessMinutes(cal(), gye('2025-10-13T17:59:00'), 15).toISOString()).toBe(gye('2025-10-14T08:44:00').toISOString());
  });

  it('si empieza fuera de horario, cuenta desde la apertura; un feriado se salta como un domingo', () => {
    expect(addBusinessMinutes(cal(), gye('2025-10-12T10:00:00'), 15).toISOString()).toBe(gye('2025-10-13T08:45:00').toISOString());
    expect(addBusinessMinutes(cal({ holidays: new Set(['2025-10-13']) }), gye('2025-10-11T17:50:00'), 15).toISOString()).toBe(gye('2025-10-14T08:35:00').toISOString());
    expect(addBusinessMinutes(cal({ yearly: new Set(['10-13']) }), gye('2026-10-10T17:50:00'), 15).toISOString()).toBe(gye('2026-10-12T08:35:00').toISOString()); // 12/10/2026 es lunes; el 13 ya es martes y feriado anual: se cuenta el 12
  });

  it('con tramos partidos (pausa de almuerzo) no cuenta la pausa', () => {
    const split: Week = [[], ...Array.from({ length: 6 }, () => [hm(t(8), t(12)), hm(t(14), t(18))])];
    expect(addBusinessMinutes(cal({ week: split }), gye('2025-10-13T11:45:00'), 30).toISOString()).toBe(gye('2025-10-13T14:15:00').toISOString());
    expect(addBusinessMinutes(cal({ week: split }), gye('2025-10-13T12:30:00'), 30).toISOString()).toBe(gye('2025-10-13T14:30:00').toISOString());
  });

  it('sin horario configurado (abierto siempre) es el tiempo corrido; sin ningún día abierto, también (el cronómetro nunca queda sin vencer)', () => {
    const open = alwaysOpen(GYE);
    expect(addBusinessMinutes(open, gye('2025-10-12T23:50:00'), 30).toISOString()).toBe(gye('2025-10-13T00:20:00').toISOString());
    expect(isOpenAt(open, gye('2025-12-25T03:00:00'))).toBe(true);
    const closed = cal({ week: Array.from({ length: 7 }, () => []) });
    expect(addBusinessMinutes(closed, gye('2025-10-13T09:00:00'), 15).toISOString()).toBe(gye('2025-10-13T09:15:00').toISOString());
  });
});

describe('tiempo abierto transcurrido (el tiempo de respuesta)', () => {
  it('solo cuenta lo abierto: sábado 17:00 → lunes 09:00 son 1 h + 30 min', () => {
    expect(businessSecondsBetween(cal(), gye('2025-10-11T17:00:00'), gye('2025-10-13T09:00:00'))).toBe(3600 + 1800);
    expect(businessSecondsBetween(cal({ holidays: new Set(['2025-10-13']) }), gye('2025-10-11T17:00:00'), gye('2025-10-14T09:00:00'))).toBe(3600 + 1800);
    expect(businessSecondsBetween(cal(), gye('2025-10-12T01:00:00'), gye('2025-10-12T23:00:00'))).toBe(0); // todo el domingo
    expect(businessSecondsBetween(cal(), gye('2025-10-13T09:00:00'), gye('2025-10-13T09:00:00'))).toBe(0);
    expect(businessSecondsBetween(cal(), gye('2025-10-13T10:00:00'), gye('2025-10-13T09:00:00'))).toBe(0); // al revés, nada
  });

  it('abierto siempre = tiempo corrido', () => {
    expect(businessSecondsBetween(alwaysOpen(GYE), gye('2025-10-12T22:00:00'), gye('2025-10-13T02:30:00'))).toBe(4.5 * 3600);
  });

  it('sumar y medir son inversas: medir hasta la fecha límite da exactamente los minutos pedidos (con cualquier inicio)', () => {
    const c = cal({ holidays: new Set(['2025-10-14']), yearly: new Set(['10-18']) });
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 300; i++) {
      const start = new Date(gye('2025-10-01T00:00:00').getTime() + Math.floor(rnd() * 40 * 86_400_000));
      const minutes = 1 + Math.floor(rnd() * 3000);
      const due = addBusinessMinutes(c, start, minutes);
      expect(due.getTime()).toBeGreaterThanOrEqual(start.getTime() + minutes * 60_000);
      expect(businessSecondsBetween(c, start, due), `${start.toISOString()} + ${minutes}`).toBe(minutes * 60);
    }
  });
});

describe('cambio de horario', () => {
  const open24: Week = Array.from({ length: 7 }, () => [hm(0, 1440)]);
  const ny = (week: Week, extra: Partial<Calendar> = {}): Calendar => ({ timeZone: NY, week, holidays: new Set(), yearly: new Set(), ...extra });

  it('un día con cambio de horario dura 23 o 25 horas y el tiempo abierto lo refleja', () => {
    const c = ny(open24);
    const day = (y: number, m: number, d: number) => [instantAt({ y, m, d }, 0, NY), instantAt({ y, m, d: d + 1 }, 0, NY)] as const;
    const [a1, b1] = day(2025, 3, 9); // se adelanta una hora
    expect(businessSecondsBetween(c, a1, b1)).toBe(23 * 3600);
    const [a2, b2] = day(2025, 11, 2); // se atrasa una hora
    expect(businessSecondsBetween(c, a2, b2)).toBe(25 * 3600);
    const [a3, b3] = day(2025, 7, 4);
    expect(businessSecondsBetween(c, a3, b3)).toBe(24 * 3600);
  });

  it('un tramo de la mañana del día del cambio mantiene su duración real', () => {
    const c = ny(Array.from({ length: 7 }, () => [hm(t(8), t(10))]));
    const start = instantAt({ y: 2025, m: 3, d: 9 }, 0, NY);
    const due = addBusinessMinutes(c, start, 120);
    expect(localDate(due, NY)).toEqual({ y: 2025, m: 3, d: 9, minutes: t(10) });
    expect(due.getTime() - instantAt({ y: 2025, m: 3, d: 9 }, t(8), NY).getTime()).toBe(2 * 3600_000);
  });

  it('un tramo que cae en la hora que no existe no rompe el cálculo', () => {
    const c = ny(Array.from({ length: 7 }, () => [hm(t(2, 30), t(3, 30))]));
    const start = instantAt({ y: 2025, m: 3, d: 9 }, 0, NY);
    const due = addBusinessMinutes(c, start, 20);
    expect(Number.isFinite(due.getTime())).toBe(true);
    expect(businessSecondsBetween(c, start, due)).toBe(20 * 60);
  });
});

describe('el horario como lo escribe una persona', () => {
  it('«HH:MM» ↔ minutos; «24:00» solo como cierre', () => {
    expect(parseTime('08:30')).toBe(510);
    expect(parseTime('24:00', true)).toBe(1440);
    expect(parseTime('24:00')).toBeNull();
    for (const bad of ['8:30', '25:00', '12:60', '', 'abc', '08:30:00']) expect(parseTime(bad), bad).toBeNull();
    expect(formatTime(510)).toBe('08:30');
    expect(formatTime(1440)).toBe('24:00');
  });

  it('valida los tramos: formato, inicio antes del fin, sin solaparse, en orden y hasta 3 por día', () => {
    const ok = parseWeek({ mon: [['08:30', '12:00'], ['14:00', '18:00']], sat: [['09:00', '24:00']] });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.week[1]).toEqual([[510, 720], [840, 1080]]);
      expect(ok.week[6]).toEqual([[540, 1440]]);
      expect(ok.week[0]).toEqual([]);
      expect(weekHasOpenTime(ok.week)).toBe(true);
      expect(weekToInput(ok.week).mon).toEqual([['08:30', '12:00'], ['14:00', '18:00']]);
      expect(weekFromJson(weekToJson(ok.week))).toEqual(ok.week);
    }
    const bad = (w: Parameters<typeof parseWeek>[0]) => parseWeek(w);
    expect(bad({ mon: [['8:30', '12:00']] })).toMatchObject({ ok: false, path: 'mon.0' });
    expect(bad({ tue: [['12:00', '12:00']] })).toMatchObject({ ok: false, path: 'tue.0' });
    expect(bad({ wed: [['12:00', '10:00']] })).toMatchObject({ ok: false, path: 'wed.0' });
    expect(bad({ thu: [['08:00', '12:00'], ['11:00', '13:00']] })).toMatchObject({ ok: false, path: 'thu.1' });
    expect(bad({ fri: [['14:00', '18:00'], ['08:00', '12:00']] })).toMatchObject({ ok: false, path: 'fri.1' });
    expect(bad({ sat: [['08:00', '09:00'], ['10:00', '11:00'], ['12:00', '13:00'], ['14:00', '15:00']] })).toMatchObject({ ok: false, path: 'sat' });
    expect(bad({ sun: [['24:00', '24:00']] })).toMatchObject({ ok: false });
    const closed = parseWeek({});
    expect(closed.ok && weekHasOpenTime(closed.week)).toBe(false);
  });

  it('lo guardado se lee con tolerancia: lo raro es un día sin tramos', () => {
    expect(weekFromJson(null)).toEqual(Array.from({ length: 7 }, () => []));
    expect(weekFromJson([[[510, 1080]], 'x', [[900, 600]], [[0, 2000]], [['a', 'b']], [[0, 1440]]])[0]).toEqual([[510, 1080]]);
    const w = weekFromJson([[[510, 1080]], 'x', [[900, 600]], [[0, 2000]], [['a', 'b']], [[0, 1440]]]);
    expect(w.slice(1)).toEqual([[], [], [], [], [[0, 1440]], []]);
  });
});
