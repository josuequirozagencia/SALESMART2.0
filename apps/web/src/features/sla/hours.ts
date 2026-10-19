import type { DayHours, WeekHours, WeekdayKey } from '../../lib/types';

/** Orden de presentación: la semana empieza el lunes. */
export const WEEKDAYS: Array<{ key: WeekdayKey; label: string; short: string }> = [
  { key: 'mon', label: 'Lunes', short: 'Lun' },
  { key: 'tue', label: 'Martes', short: 'Mar' },
  { key: 'wed', label: 'Miércoles', short: 'Mié' },
  { key: 'thu', label: 'Jueves', short: 'Jue' },
  { key: 'fri', label: 'Viernes', short: 'Vie' },
  { key: 'sat', label: 'Sábado', short: 'Sáb' },
  { key: 'sun', label: 'Domingo', short: 'Dom' },
];

/** Tramos máximos por día (el servidor lo vuelve a exigir). */
export const MAX_INTERVALS = 3;
export const DEFAULT_INTERVAL: [string, string] = ['08:30', '18:00'];

/** «25/12/2026» a partir de AAAA-MM-DD (sin pasar por Date: una fecha de calendario no tiene zona horaria). */
export const holidayDate = (iso: string): string => iso.split('-').reverse().join('/');

export const emptyWeek = (): WeekHours => ({ mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] });

/** Punto de partida al activar un horario: lunes a viernes de 08:30 a 18:00. */
export function defaultWeek(): WeekHours {
  const w = emptyWeek();
  for (const k of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) w[k] = [[...DEFAULT_INTERVAL]];
  return w;
}

/** Copia editable (los tramos son arreglos que el formulario cambia). */
export const cloneWeek = (w: WeekHours): WeekHours => Object.fromEntries(WEEKDAYS.map((d) => [d.key, w[d.key].map(([a, b]) => [a, b] as [string, string])])) as WeekHours;

export function sameWeek(a: WeekHours | null, b: WeekHours | null): boolean {
  if (a === null || b === null) return a === b;
  return WEEKDAYS.every((d) => JSON.stringify(a[d.key]) === JSON.stringify(b[d.key]));
}

const START = /^([01]\d|2[0-3]):[0-5]\d$/;
const END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Revisa los tramos de un día; devuelve el problema en palabras o null si están bien. */
function checkDay(label: string, day: DayHours): string | null {
  let prevEnd = -1;
  for (const [i, [from, to]] of day.entries()) {
    const n = i + 1;
    if (!START.test(from)) return `${label}, tramo ${n}: la hora de inicio debe ser HH:MM en formato de 24 horas (por ejemplo 08:30).`;
    if (!END.test(to)) return `${label}, tramo ${n}: la hora de fin debe ser HH:MM en formato de 24 horas (por ejemplo 18:00; usa 24:00 para el final del día).`;
    if (minutes(to) <= minutes(from)) return `${label}, tramo ${n}: el fin debe ser después del inicio.`;
    if (minutes(from) < prevEnd) return `${label}, tramo ${n}: se cruza con el tramo anterior; ordénalos de menor a mayor sin solaparlos.`;
    prevEnd = minutes(to);
  }
  return null;
}

/** Lo que el servidor exigirá, dicho antes de enviar. null = el horario es válido. */
export function validateWeek(w: WeekHours): string | null {
  for (const d of WEEKDAYS) {
    const problem = checkDay(d.label, w[d.key]);
    if (problem) return problem;
  }
  if (WEEKDAYS.every((d) => w[d.key].length === 0)) return 'Abre al menos un día. Para que la empresa esté abierta siempre, quita el horario.';
  return null;
}

/** «Lun a Vie 08:30–18:00 · Sáb 09:00–13:00»: el horario en una línea (días seguidos con los mismos tramos se agrupan). */
export function summarizeWeek(w: WeekHours): string {
  const groups: Array<{ days: Array<(typeof WEEKDAYS)[number]>; text: string }> = [];
  for (const d of WEEKDAYS) {
    if (w[d.key].length === 0) continue;
    const text = w[d.key].map(([a, b]) => `${a}–${b}`).join(' y ');
    const last = groups.at(-1);
    const prev = last?.days.at(-1);
    if (last && prev && WEEKDAYS.indexOf(prev) === WEEKDAYS.indexOf(d) - 1 && last.text === text) last.days.push(d);
    else groups.push({ days: [d], text });
  }
  return groups.map((g) => `${g.days.length > 1 ? `${g.days[0]!.short} a ${g.days.at(-1)!.short}` : g.days[0]!.short} ${g.text}`).join(' · ');
}
