import { addDays, instantAt, localDate, weekdayOf, type LocalDate } from '../../time/zone';

/**
 * Calendario laboral (M5.5b, ADR-50): cuándo está «abierto» un negocio. Funciones PURAS y sin base de datos: el SLA mide el tiempo de respuesta solo mientras está
 * abierto —horario por día de la semana, feriados y la zona horaria de la empresa— y la reasignación espera lo mismo. Todo se calcula en INSTANTES (no en minutos de
 * pared), así que un día con cambio de horario dura lo que dura de verdad.
 */

/** Tramo de un día, en minutos desde la medianoche local: 0 ≤ inicio < fin ≤ 1440. */
export type Interval = readonly [start: number, end: number];

/** Días de la semana, con el domingo en 0 (como `Date#getUTCDay`). */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAYS)[number];

/** Horario de cada día de la semana (índice 0 = domingo). Un día sin tramos está cerrado. */
export type Week = ReadonlyArray<readonly Interval[]>;

export interface Calendar {
  readonly timeZone: string;
  readonly week: Week;
  /** Feriados de una fecha exacta, «AAAA-MM-DD». */
  readonly holidays: ReadonlySet<string>;
  /** Feriados que se repiten cada año, «MM-DD». */
  readonly yearly: ReadonlySet<string>;
}

/** Máximo de tramos por día (provisional). */
export const MAX_INTERVALS_PER_DAY = 3;
const DAY = 1440;
/** Cuántos días hacia adelante se busca tiempo abierto antes de rendirse (un calendario sin ningún día abierto). */
const HORIZON_DAYS = 400;

/** Una semana abierta las 24 h, todos los días: el horario de quien aún no configuró el suyo. */
export const OPEN_ALWAYS: Week = Array.from({ length: 7 }, () => [[0, DAY] as const]);

export const alwaysOpen = (timeZone: string): Calendar => ({ timeZone, week: OPEN_ALWAYS, holidays: new Set(), yearly: new Set() });

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
const dateKey = (d: LocalDate): string => `${pad(d.y, 4)}-${pad(d.m)}-${pad(d.d)}`;
const yearlyKey = (d: LocalDate): string => `${pad(d.m)}-${pad(d.d)}`;

export const isHoliday = (cal: Calendar, d: LocalDate): boolean => cal.holidays.has(dateKey(d)) || cal.yearly.has(yearlyKey(d));

/** Los tramos abiertos de un día, como instantes [inicio, fin). Un feriado no tiene ninguno. */
function dayWindows(cal: Calendar, d: LocalDate): Array<readonly [number, number]> {
  if (isHoliday(cal, d)) return [];
  return (cal.week[weekdayOf(d)] ?? []).map(([s, e]) => [instantAt(d, s, cal.timeZone).getTime(), e >= DAY ? instantAt(addDays(d, 1), 0, cal.timeZone).getTime() : instantAt(d, e, cal.timeZone).getTime()] as const);
}

/** ¿Está abierto en ese instante? */
export function isOpenAt(cal: Calendar, at: Date): boolean {
  const t = at.getTime();
  return dayWindows(cal, localDate(at, cal.timeZone)).some(([s, e]) => s <= t && t < e);
}

/** El primer instante abierto desde `from` (el mismo `from` si ya está abierto); null si no hay horario abierto en más de un año. */
export function nextOpenAt(cal: Calendar, from: Date): Date | null {
  const t = from.getTime();
  let d: LocalDate = localDate(from, cal.timeZone);
  for (let i = 0; i < HORIZON_DAYS; i++) {
    for (const [s, e] of dayWindows(cal, d)) {
      if (e <= t) continue;
      return new Date(Math.max(s, t));
    }
    d = addDays(d, 1);
  }
  return null;
}

/**
 * El instante en que se cumplen `minutes` minutos de tiempo ABIERTO contados desde `start`. Si `start` cae fuera de horario, el conteo arranca en la próxima
 * apertura. Sin ningún día abierto en más de un año (un calendario mal configurado) se cuenta en tiempo corrido, para que un cronómetro nunca quede sin vencer.
 */
export function addBusinessMinutes(cal: Calendar, start: Date, minutes: number): Date {
  if (minutes <= 0) return start;
  let remaining = minutes * 60_000;
  let cursor = start.getTime();
  let d: LocalDate = localDate(start, cal.timeZone);
  for (let i = 0; i < HORIZON_DAYS; i++) {
    for (const [s, e] of dayWindows(cal, d)) {
      if (e <= cursor) continue;
      const from = Math.max(s, cursor);
      const available = e - from;
      if (remaining <= available) return new Date(from + remaining);
      remaining -= available;
      cursor = e;
    }
    d = addDays(d, 1);
  }
  return new Date(start.getTime() + minutes * 60_000);
}

/** Milisegundos de tiempo ABIERTO entre dos instantes. */
export function businessMsBetween(cal: Calendar, a: Date, b: Date): number {
  const from = a.getTime();
  const to = b.getTime();
  if (to <= from) return 0;
  let total = 0;
  let d: LocalDate = localDate(a, cal.timeZone);
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const dayStart = instantAt(d, 0, cal.timeZone).getTime();
    if (dayStart >= to) break;
    for (const [s, e] of dayWindows(cal, d)) {
      const lo = Math.max(s, from);
      const hi = Math.min(e, to);
      if (hi > lo) total += hi - lo;
    }
    d = addDays(d, 1);
  }
  return total;
}

/** Segundos de tiempo abierto entre dos instantes (redondeado hacia abajo). */
export const businessSecondsBetween = (cal: Calendar, a: Date, b: Date): number => Math.floor(businessMsBetween(cal, a, b) / 1000);

// ── el horario como lo escribe una persona («HH:MM») ──────────────────────────

export type WeekInput = Partial<Record<WeekdayKey, ReadonlyArray<readonly [string, string]>>>;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** «08:30» → 510; «24:00» solo vale como fin de un tramo (1440). null si no es una hora válida. */
export function parseTime(text: string, asEnd = false): number | null {
  if (asEnd && text === '24:00') return DAY;
  const m = TIME_RE.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function formatTime(minute: number): string {
  return minute >= DAY ? '24:00' : `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/**
 * Valida y convierte el horario que escribe una persona. Devuelve la semana o el primer problema encontrado. Reglas: cada tramo con inicio < fin, ordenados y sin
 * solaparse, hasta `MAX_INTERVALS_PER_DAY` por día; un día sin tramos está cerrado.
 */
export function parseWeek(input: WeekInput): { ok: true; week: Week } | { ok: false; path: string; message: string } {
  const week: Interval[][] = Array.from({ length: 7 }, () => []);
  for (const [i, key] of WEEKDAYS.entries()) {
    const day = input[key] ?? [];
    if (day.length > MAX_INTERVALS_PER_DAY) return { ok: false, path: key, message: `Como máximo ${MAX_INTERVALS_PER_DAY} tramos por día` };
    let last = -1;
    for (const [n, [a, b]] of day.entries()) {
      const s = parseTime(a);
      const e = parseTime(b, true);
      if (s === null || e === null) return { ok: false, path: `${key}.${n}`, message: 'Usa horas en formato HH:MM' };
      if (s >= e) return { ok: false, path: `${key}.${n}`, message: 'La hora de apertura debe ser anterior a la de cierre' };
      if (s < last) return { ok: false, path: `${key}.${n}`, message: 'Los tramos de un día no pueden solaparse y van en orden' };
      week[i]!.push([s, e]);
      last = e;
    }
  }
  return { ok: true, week };
}

/** El horario como lo ve una persona: «HH:MM» por día. */
export function weekToInput(week: Week): Record<WeekdayKey, Array<[string, string]>> {
  return Object.fromEntries(WEEKDAYS.map((key, i) => [key, (week[i] ?? []).map(([s, e]) => [formatTime(s), formatTime(e)] as [string, string])])) as Record<WeekdayKey, Array<[string, string]>>;
}

/** ¿Es una semana con al menos un tramo abierto? (Una semana totalmente cerrada no tiene sentido como horario de trabajo.) */
export const weekHasOpenTime = (week: Week): boolean => week.some((d) => d.length > 0);

/** Lo que se guarda en la base: minutos por día, como arreglo de 7 elementos. */
export const weekToJson = (week: Week): number[][][] => week.map((d) => d.map(([s, e]) => [s, e]));

/** Lee lo guardado con tolerancia: cualquier cosa rara es «sin tramos». */
export function weekFromJson(value: unknown): Week {
  const out: Interval[][] = Array.from({ length: 7 }, () => []);
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < 7; i++) {
    const day = value[i];
    if (!Array.isArray(day)) continue;
    for (const iv of day) {
      if (Array.isArray(iv) && typeof iv[0] === 'number' && typeof iv[1] === 'number' && iv[0] >= 0 && iv[0] < iv[1] && iv[1] <= DAY) out[i]!.push([iv[0], iv[1]]);
    }
  }
  return out;
}
