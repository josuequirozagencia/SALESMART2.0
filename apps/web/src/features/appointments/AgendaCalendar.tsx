import { addDays, isoToZoned, timeIn } from '../../lib/zone';
import type { Appointment } from './useAppointments';

export type AgendaView = 'month' | 'week';

const WEEKDAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const CHIP: Record<Appointment['status'], string> = {
  scheduled: 'border-accent bg-accent-soft text-fg',
  completed: 'border-ok bg-ok-soft text-fg',
  cancelled: 'border-line bg-surface2 text-muted line-through',
};
const MAX_CHIPS_MONTH = 3;

/** El lunes de la semana que contiene `date` (YYYY-MM-DD). */
export function mondayOf(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return addDays(date, -((dow + 6) % 7));
}
/** El primer día del mes de `date`. */
export const monthStart = (date: string): string => `${date.slice(0, 7)}-01`;
/** El primer día del mes `n` meses antes o después del de `date`. */
export function shiftMonth(date: string, n: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`;
}
/** Los días que se pintan: 6 semanas completas para el mes (desde el lunes anterior al día 1) o 7 días para la semana. */
export function visibleDays(view: AgendaView, anchor: string): string[] {
  const start = view === 'month' ? mondayOf(monthStart(anchor)) : mondayOf(anchor);
  return Array.from({ length: view === 'month' ? 42 : 7 }, (_, i) => addDays(start, i));
}

const monthLabel = (date: string): string => new Intl.DateTimeFormat('es-EC', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${date}T00:00:00Z`));
const dayNum = (date: string): number => Number(date.slice(8));
const fullLabel = (date: string): string => new Intl.DateTimeFormat('es-EC', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T00:00:00Z`));
export const periodLabel = (view: AgendaView, anchor: string): string => {
  if (view === 'month') return monthLabel(anchor);
  const mon = mondayOf(anchor);
  return `${fullLabel(mon)} – ${fullLabel(addDays(mon, 6))}`;
};

/**
 * Calendario de la agenda (M5.8): vista de mes o de semana, siempre visible. Cada día lista sus citas (hora de la empresa); el día con citas queda marcado y al pulsar un
 * día se elige para ver su detalle debajo. Es una cuadrícula con botones normales (Tab llega a cada día y a cada cita), sin dependencias.
 */
export function AgendaCalendar({ view, anchor, today, tz, items, selected, onSelect, onOpen }: { view: AgendaView; anchor: string; today: string; tz: string; items: Appointment[]; selected: string; onSelect: (day: string) => void; onOpen: (id: string) => void }) {
  const days = visibleDays(view, anchor);
  const byDay = new Map<string, Appointment[]>();
  for (const a of items) {
    const d = isoToZoned(a.starts_at, tz).date;
    byDay.set(d, [...(byDay.get(d) ?? []), a].sort((x, y) => x.starts_at.localeCompare(y.starts_at)));
  }
  const month = anchor.slice(0, 7);
  return (
    <div role="grid" aria-label={`Calendario de ${periodLabel(view, anchor)}`} className="overflow-hidden rounded-xl border border-line bg-surface">
      <div role="row" className="grid grid-cols-7 border-b border-line bg-surface2 text-center text-[11.5px] font-semibold uppercase text-muted">
        {WEEKDAYS.map((w) => <div key={w} role="columnheader" className="py-1.5">{w}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const list = byDay.get(d) ?? [];
          const outside = view === 'month' && d.slice(0, 7) !== month;
          const chips = view === 'month' ? list.slice(0, MAX_CHIPS_MONTH) : list;
          const more = list.length - chips.length;
          return (
            <div key={d} role="gridcell" aria-selected={d === selected} className={`min-h-[84px] min-w-0 border-b border-r border-line p-1 ${view === 'week' ? 'min-h-[180px]' : ''} ${outside ? 'bg-surface2/50' : ''} ${d === selected ? 'ring-2 ring-inset ring-accent' : ''}`}>
              <button
                type="button"
                onClick={() => onSelect(d)}
                aria-label={`${fullLabel(d)}${list.length > 0 ? `, ${list.length} ${list.length === 1 ? 'cita' : 'citas'}` : ', sin citas'}`}
                className={`mb-1 grid size-7 place-items-center rounded-full text-[12.5px] font-semibold ${d === today ? 'bg-accent text-accent-ink' : outside ? 'text-muted' : 'text-fg hover:bg-surface2'}`}
              >
                {dayNum(d)}
              </button>
              {list.length > 0 ? <span className="sr-only">{list.length} {list.length === 1 ? 'cita' : 'citas'}</span> : null}
              <ul className="grid gap-0.5">
                {chips.map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => onOpen(a.id)} aria-label={`Abrir la cita de ${a.contact.name}, ${timeIn(a.starts_at, tz)}`} title={`${timeIn(a.starts_at, tz)} · ${a.contact.name} · ${a.kind}`} className={`block w-full truncate rounded border-l-2 px-1 py-px text-left text-[11px] leading-snug ${CHIP[a.status]}`}>
                      <span className="font-mono">{timeIn(a.starts_at, tz)}</span> {a.contact.name}
                    </button>
                  </li>
                ))}
              </ul>
              {more > 0 ? <button type="button" onClick={() => onSelect(d)} className="mt-0.5 text-[11px] font-semibold text-accent hover:underline">+{more} más</button> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
