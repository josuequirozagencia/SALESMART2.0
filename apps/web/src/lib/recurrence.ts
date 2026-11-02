import type { TaskRecurrence } from './types';

/** Días de la semana en el orden en que se muestran (lunes primero); `value` es el del servidor: 0 = domingo … 6 = sábado. */
export const WEEKDAYS: ReadonlyArray<{ value: number; short: string; long: string }> = [
  { value: 1, short: 'lun', long: 'lunes' },
  { value: 2, short: 'mar', long: 'martes' },
  { value: 3, short: 'mié', long: 'miércoles' },
  { value: 4, short: 'jue', long: 'jueves' },
  { value: 5, short: 'vie', long: 'viernes' },
  { value: 6, short: 'sáb', long: 'sábado' },
  { value: 0, short: 'dom', long: 'domingo' },
];

const dmy = (iso: string): string => iso.split('-').reverse().join('/');

/** «Cada semana: lun, mié», «Cada 3 meses, el día 15», «Cada día, hasta el 12/02/2030»: la regla en palabras. */
export function describeRecurrence(r: Pick<TaskRecurrence, 'freq' | 'interval' | 'weekdays' | 'day_of_month' | 'ends'>): string {
  const n = r.interval;
  let text: string;
  if (r.freq === 'daily') text = n === 1 ? 'Cada día' : `Cada ${n} días`;
  else if (r.freq === 'weekly') {
    const days = (r.weekdays ?? []).map((d) => WEEKDAYS.find((w) => w.value === d)?.short).filter((x): x is string => Boolean(x));
    const order = (s: string): number => WEEKDAYS.findIndex((w) => w.short === s);
    const list = [...days].sort((a, b) => order(a) - order(b)).join(', ');
    text = `${n === 1 ? 'Cada semana' : `Cada ${n} semanas`}${list ? `: ${list}` : ''}`;
  } else text = `${n === 1 ? 'Cada mes' : `Cada ${n} meses`}${r.day_of_month ? `, el día ${r.day_of_month}` : ''}`;
  if (r.ends.kind === 'on') text += `, hasta el ${dmy(r.ends.date)}`;
  else if (r.ends.kind === 'after') text += `, ${r.ends.count} veces en total`;
  return text;
}

/** Los minutos de anticipo que ofrece el aviso de vencimiento, con su texto. `null` = al vencer. */
export const REMIND_OPTIONS: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: null, label: 'Al vencer' },
  { value: 15, label: '15 minutos antes' },
  { value: 60, label: '1 hora antes' },
  { value: 1440, label: '1 día antes' },
];
