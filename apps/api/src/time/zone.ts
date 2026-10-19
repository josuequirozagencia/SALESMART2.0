/**
 * Utilidades de zona horaria (IANA) sin dependencias: lo que el tope diario del reparto (M5.3) y el calendario laboral del SLA (M5.5b) necesitan. Funciones puras; el
 * «desfase» de una zona se calcula en el propio instante, de modo que valen también para zonas con cambio de horario.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** ¿Es una zona horaria IANA que este entorno conoce? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Desfase (en ms) de la zona respecto de UTC en ese instante: hora de pared − hora UTC. */
export function offsetMs(at: Date, timeZone: string): number {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p['year']), Number(p['month']) - 1, Number(p['day']), Number(p['hour']), Number(p['minute']), Number(p['second']));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Un día del calendario (de pared, en una zona). `m` es 1–12. */
export interface LocalDate {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

/** La fecha de pared de un instante en la zona, y los minutos transcurridos desde su medianoche local. */
export function localDate(at: Date, timeZone: string): LocalDate & { readonly minutes: number } {
  const wall = new Date(at.getTime() + offsetMs(at, timeZone)); // la hora de pared, leída como UTC
  return { y: wall.getUTCFullYear(), m: wall.getUTCMonth() + 1, d: wall.getUTCDate(), minutes: wall.getUTCHours() * 60 + wall.getUTCMinutes() };
}

/** El día siguiente del calendario (sirve también para retroceder con un `delta` negativo). */
export function addDays(date: LocalDate, delta: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + delta));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Día de la semana de una fecha del calendario: 0 = domingo … 6 = sábado. */
export const weekdayOf = (date: LocalDate): number => new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();

const DAY_MS = 86_400_000;

/**
 * El instante en que, en la zona, la hora de pared es `minute` minutos después de la medianoche de ese día (0–1440; 1440 = la medianoche siguiente). Con el cambio de
 * horario: una hora que se repite (el reloj se atrasa) es la primera vez que ocurre; una que no existe (el reloj se adelanta) se corre hacia adelante lo que dura el salto.
 */
export function instantAt(date: LocalDate, minute: number, timeZone: string): Date {
  const wall = Date.UTC(date.y, date.m - 1, date.d, 0, minute);
  // Los desfases del día anterior y del siguiente: solo difieren el día del cambio
  const c1 = wall - offsetMs(new Date(wall - DAY_MS), timeZone);
  const c2 = wall - offsetMs(new Date(wall + DAY_MS), timeZone);
  const shows = (c: number): boolean => c + offsetMs(new Date(c), timeZone) === wall;
  const a = shows(c1);
  const b = shows(c2);
  if (a && b) return new Date(Math.min(c1, c2));
  if (a) return new Date(c1);
  if (b) return new Date(c2);
  return new Date(Math.max(c1, c2));
}
