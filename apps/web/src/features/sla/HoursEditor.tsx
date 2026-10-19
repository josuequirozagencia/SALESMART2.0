import type { WeekHours, WeekdayKey } from '../../lib/types';
import { Button } from '../../ui/controls';
import { DEFAULT_INTERVAL, MAX_INTERVALS, WEEKDAYS } from './hours';

const timeCls = 'w-[88px] rounded-lg border border-line bg-surface px-2 py-1.5 text-center font-mono text-[13px] text-fg';

/**
 * Editor del horario semanal (M5.5b): por día, abierto o cerrado y hasta tres tramos «HH:MM»–«HH:MM». Es solo la forma de capturarlo: lo que se guarda lo valida el
 * servidor (y `validateWeek` lo dice antes de enviar). Se usa en el horario de la empresa y en el propio de una cola.
 */
export function HoursEditor({ value, onChange }: { value: WeekHours; onChange: (w: WeekHours) => void }) {
  const setDay = (key: WeekdayKey, day: Array<[string, string]>) => onChange({ ...value, [key]: day });
  return (
    <ul aria-label="Horario semanal" className="grid gap-1.5">
      {WEEKDAYS.map((d) => {
        const day = value[d.key];
        const open = day.length > 0;
        return (
          <li key={d.key} className="grid gap-1.5 rounded-xl border border-line px-3 py-2 sm:grid-cols-[130px_minmax(0,1fr)] sm:items-start">
            <label className="flex items-center gap-2 py-1 text-[13.5px] font-semibold">
              <input type="checkbox" aria-label={`${d.label} abierto`} checked={open} onChange={(e) => setDay(d.key, e.target.checked ? [[...DEFAULT_INTERVAL]] : [])} />
              {d.label}
            </label>
            {open ? (
              <div className="grid gap-1.5">
                {day.map(([from, to], i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                    <input aria-label={`${d.label} tramo ${i + 1} desde`} inputMode="numeric" placeholder="08:30" maxLength={5} value={from} onChange={(e) => setDay(d.key, day.map((t, j) => (j === i ? [e.target.value, t[1]] : t)))} className={timeCls} />
                    <span aria-hidden="true">a</span>
                    <input aria-label={`${d.label} tramo ${i + 1} hasta`} inputMode="numeric" placeholder="18:00" maxLength={5} value={to} onChange={(e) => setDay(d.key, day.map((t, j) => (j === i ? [t[0], e.target.value] : t)))} className={timeCls} />
                    {day.length > 1 ? <Button variant="link" className="text-[12.5px]" aria-label={`Quitar el tramo ${i + 1} del ${d.label.toLowerCase()}`} onClick={() => setDay(d.key, day.filter((_, j) => j !== i))}>Quitar</Button> : null}
                  </div>
                ))}
                {day.length < MAX_INTERVALS ? (
                  <div><Button variant="link" className="text-[12.5px]" aria-label={`Agregar un tramo el ${d.label.toLowerCase()}`} onClick={() => setDay(d.key, [...day, ['14:00', '18:00']])}>+ Agregar tramo</Button></div>
                ) : null}
              </div>
            ) : <span className="py-1 text-[12.5px] text-muted">Cerrado</span>}
          </li>
        );
      })}
    </ul>
  );
}
