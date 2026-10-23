/**
 * Fechas en la zona horaria de la EMPRESA (no la del navegador): la agenda, las citas y los recordatorios se piensan y se ven en la hora del negocio (ADR-51). Solo con `Intl`,
 * sin librerías. Los instantes viajan siempre como ISO 8601 en UTC.
 */

const parts = (ms: number, timeZone: string): Record<string, number> => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
};

/** Cuánto se adelanta la hora de la zona respecto de UTC en ese instante (ms). */
function offsetMs(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  return Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!) - Math.floor(ms / 1000) * 1000;
}

/** «2026-10-24» + «15:30» en la zona de la empresa → instante ISO en UTC (null si el texto no es una fecha y hora válidas). */
export function zonedToIso(date: string, time: string, timeZone: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (Number.isNaN(guess)) return null;
  let utc = guess - offsetMs(guess, timeZone);
  // Con cambio de hora el desfase puede ser otro en el instante resultante: se ajusta una vez
  const again = guess - offsetMs(utc, timeZone);
  if (again !== utc) utc = again;
  return new Date(utc).toISOString();
}

/** La fecha («YYYY-MM-DD») y la hora («HH:mm») de un instante en la zona de la empresa. */
export function isoToZoned(iso: string, timeZone: string): { date: string; time: string } {
  const p = parts(Date.parse(iso), timeZone);
  const two = (n: number): string => String(n).padStart(2, '0');
  return { date: `${p['year']}-${two(p['month']!)}-${two(p['day']!)}`, time: `${two(p['hour']!)}:${two(p['minute']!)}` };
}

/** Hoy («YYYY-MM-DD») en la zona de la empresa. */
export const todayIn = (timeZone: string, now = Date.now()): string => isoToZoned(new Date(now).toISOString(), timeZone).date;

/** Suma días a una fecha «YYYY-MM-DD» (calendario, sin zona). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Etiqueta legible de un día («sábado 24 de octubre») a partir de «YYYY-MM-DD». */
export const dayLabel = (date: string): string => new Intl.DateTimeFormat('es-EC', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T00:00:00Z`));

/** Hora de un instante en la zona de la empresa («15:30»). */
export const timeIn = (iso: string, timeZone: string): string => isoToZoned(iso, timeZone).time;

/** Fecha y hora completas en la zona de la empresa. */
export const dateTimeIn = (iso: string, timeZone: string): string => new Intl.DateTimeFormat('es-EC', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
