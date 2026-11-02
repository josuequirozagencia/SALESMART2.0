import { addDays, instantAt, localDate, weekdayOf, type LocalDate } from '../../time/zone';

/**
 * Regla de repetición de una tarea (F2, ADR-58) y su cálculo. Funciones PURAS (sin base de datos ni reloj propio): reciben la zona horaria de la empresa y «ahora».
 * La hora del día es la del vencimiento anterior, en la zona de la empresa (no se corre con el cambio de hora). Los días de la semana son 0 = domingo … 6 = sábado.
 */

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly';

export type RecurrenceEnds = { kind: 'never' } | { kind: 'on'; date: string } | { kind: 'after'; count: number };

export interface RecurrenceRule {
  readonly freq: RecurrenceFreq;
  /** «Cada N» días, semanas o meses (1–30). */
  readonly interval: number;
  /** Solo semanal: los días de la semana (0 = domingo … 6 = sábado), sin repetir. */
  readonly weekdays: readonly number[] | null;
  /** Solo mensual: el día del mes (1–31); si el mes no lo tiene, el último. */
  readonly dayOfMonth: number | null;
  readonly ends: RecurrenceEnds;
}

/** Cuántos pasos de la regla se prueban como máximo antes de rendirse (una tarea atrasada durante años). */
const MAX_STEPS = 20_000;

const pad = (n: number): string => String(n).padStart(2, '0');
const key = (d: LocalDate): string => `${d.y}-${pad(d.m)}-${pad(d.d)}`;
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const after = (a: LocalDate, b: LocalDate): boolean => key(a) > key(b);

/** Las fechas de la regla, de la más próxima a la más lejana, siempre posteriores al día de la ocurrencia anterior. La regla se mide desde esa ocurrencia, así que lo atrasado se salta sin salirse de la cuadrícula. */
function* dates(rule: RecurrenceRule, prev: LocalDate): Generator<LocalDate> {
  const n = rule.interval;
  if (rule.freq === 'daily') {
    for (let k = 1; k <= MAX_STEPS; k += 1) yield addDays(prev, k * n);
  } else if (rule.freq === 'weekly') {
    const days = [...new Set(rule.weekdays ?? [weekdayOf(prev)])].sort((a, b) => a - b);
    const weekStart = addDays(prev, -weekdayOf(prev)); // el domingo de la semana de la ocurrencia anterior
    for (let w = 0; w <= MAX_STEPS; w += 1) {
      for (const wd of days) {
        const d = addDays(weekStart, w * n * 7 + wd);
        if (after(d, prev)) yield d;
      }
    }
  } else {
    const dom = rule.dayOfMonth ?? prev.d;
    for (let k = 0; k <= MAX_STEPS; k += 1) {
      const idx = prev.y * 12 + (prev.m - 1) + k * n;
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const d: LocalDate = { y, m, d: Math.min(dom, daysInMonth(y, m)) };
      if (after(d, prev)) yield d;
    }
  }
}

/**
 * El vencimiento de la siguiente ocurrencia: la primera fecha de la regla ESTRICTAMENTE posterior a la mayor entre el vencimiento anterior y `now`, a la misma hora de pared.
 * `createdCount` es cuántas ocurrencias lleva la serie (la que se completa cuenta). `null` = la serie llegó a su fin (por conteo o por fecha).
 */
export function nextOccurrence(rule: RecurrenceRule, prevDue: Date, now: Date, timeZone: string, createdCount: number): Date | null {
  if (rule.ends.kind === 'after' && createdCount >= rule.ends.count) return null;
  const base = Math.max(prevDue.getTime(), now.getTime());
  const prev = localDate(prevDue, timeZone);
  // Los segundos (y milisegundos) del vencimiento se conservan: los desfases de las zonas son de minutos enteros
  const subMinute = prevDue.getTime() % 60_000;
  let steps = 0;
  for (const date of dates(rule, prev)) {
    steps += 1;
    if (steps > MAX_STEPS) return null;
    const at = new Date(instantAt(date, prev.minutes, timeZone).getTime() + subMinute);
    if (at.getTime() <= base) continue;
    if (rule.ends.kind === 'on' && key(date) > rule.ends.date) return null;
    return at;
  }
  return null;
}

/** Completa lo que la persona no escribió: la semanal sin días usa el del vencimiento y la mensual, su día del mes. */
export function resolveRule(input: { freq: RecurrenceFreq; interval: number; weekdays?: readonly number[] | undefined; ends: RecurrenceEnds }, firstDue: Date, timeZone: string): RecurrenceRule {
  const local = localDate(firstDue, timeZone);
  return {
    freq: input.freq,
    interval: input.interval,
    weekdays: input.freq === 'weekly' ? [...new Set(input.weekdays && input.weekdays.length > 0 ? input.weekdays : [weekdayOf(local)])].sort((a, b) => a - b) : null,
    dayOfMonth: input.freq === 'monthly' ? local.d : null,
    ends: input.ends,
  };
}

/** Cuándo toca avisar del vencimiento: `remindBefore` minutos antes (0/`null` = al vencer). `null` si no hay vencimiento o ese momento ya pasó: no se avisa de lo que ya está vencido. */
export function noticeAt(due: Date | null, remindBefore: number | null, now: Date): Date | null {
  if (!due) return null;
  const at = new Date(due.getTime() - (remindBefore ?? 0) * 60_000);
  return at.getTime() > now.getTime() ? at : null;
}
