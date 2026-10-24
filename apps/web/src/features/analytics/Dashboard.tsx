import { useState } from 'react';
import { Link } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { durationLabel, money } from '../../lib/format';
import { Alert, Spinner } from '../../ui/controls';
import { PERIODS, usePeriod, useSummary, type Summary } from './useAnalytics';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-[9px] text-[13.5px] font-normal text-fg';

function Card({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="grid gap-0.5 rounded-2xl border border-line bg-surface px-4 py-3">
      <span className="text-[12px] font-semibold text-muted">{label}</span>
      <b className="font-mono text-[22px] leading-tight">{value}</b>
      {detail ? <span className="text-[12px] text-muted">{detail}</span> : null}
    </div>
  );
}

/** Barras horizontales sin librería: el ancho es proporcional al mayor valor. */
function Bars({ rows, label }: { rows: Array<{ key: string; name: string; value: number; text: string }>; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="grid gap-1.5">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,140px)_1fr_auto] items-center gap-2 text-[12.5px]">
          <span className="truncate" title={r.name}>{r.name}</span>
          <span className="h-3 overflow-hidden rounded-full bg-surface2"><span className="block h-full rounded-full bg-accent" style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="font-mono text-muted">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Funnel({ s }: { s: Summary }) {
  const pipelines = [...new Set(s.funnel.map((f) => f.pipeline_id))];
  if (pipelines.length === 0) return <p className="text-[13px] text-muted">Todavía no hay pipelines. Se crean en Oportunidades.</p>;
  return (
    <div className="grid gap-3">
      {pipelines.map((id) => {
        const rows = s.funnel.filter((f) => f.pipeline_id === id);
        return (
          <div key={id} className="grid gap-1.5">
            <b className="text-[13px]">{rows[0]!.pipeline}</b>
            <Bars label={`Embudo ${rows[0]!.pipeline}`} rows={rows.map((r) => ({ key: r.stage_id, name: `${r.stage}${r.kind === 'won' ? ' ✓' : r.kind === 'lost' ? ' ✗' : ''}`, value: r.count, text: `${r.count} · ${money(r.amount, s.currency)}` }))} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Tablero de inicio (M6.5, ADR-51): lo importante del periodo en pocas cifras. El asesor ve lo suyo; el administrador, toda la empresa (el servidor decide y lo informa en
 * `scope`). Las cifras salen de lo ya registrado: nada se calcula en el navegador salvo el ancho de las barras.
 */
export function Dashboard() {
  const [days, setDays] = useState(30);
  const period = usePeriod(days);
  const q = useSummary(period);
  const s = q.data;
  return (
    <section aria-label="Tablero" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-bold">Resumen</h2>
          {s ? <p className="text-[12.5px] text-muted">{s.scope === 'all' ? 'De toda la empresa' : 'Solo lo tuyo'} · hora de {s.timezone}</p> : null}
        </div>
        <label className="flex items-center gap-2 text-[13px]">Periodo
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={selectCls}>
            {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
          </select>
        </label>
      </div>
      {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando el resumen" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No se pudo cargar el resumen')}</Alert> : null}
      {s ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card label="Contactos nuevos" value={String(s.leads)} />
            <Card label="Citas" value={String(s.appointments.total)} detail={`${s.appointments.scheduled} agendadas · ${s.appointments.completed} completadas · ${s.appointments.cancelled} canceladas`} />
            <Card label="Ventas" value={String(s.sales.count)} detail={s.sales.cancelled > 0 ? `${s.sales.cancelled} anulada(s)` : undefined} />
            <Card label="Ingresos" value={money(s.sales.revenue, s.currency)} detail={`Cobrado ${money(s.sales.paid, s.currency)}`} />
            <Card label="Saldo por cobrar" value={money(s.sales.balance, s.currency)} />
            <Card label="Primera respuesta" value={s.response.count > 0 ? durationLabel(s.response.avg_seconds) : '—'} detail={s.response.count > 0 ? `Mediana ${durationLabel(s.response.median_seconds)} · ${s.response.count} conversaciones` : 'Sin respuestas en el periodo'} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <section aria-label="Embudo" className="grid gap-2 rounded-2xl border border-line bg-surface p-4">
              <b className="text-[14px]">Embudo de oportunidades</b>
              <Funnel s={s} />
            </section>
            <section aria-label="Ingresos por día" className="grid gap-2 rounded-2xl border border-line bg-surface p-4">
              <b className="text-[14px]">Ingresos por día</b>
              {s.series.some((d) => d.sales > 0) ? (
                <Bars label="Ingresos por día" rows={s.series.filter((d) => d.sales > 0).map((d) => ({ key: d.day, name: d.day, value: Number(d.revenue), text: `${money(d.revenue, s.currency)} · ${d.sales}` }))} />
              ) : <p className="text-[13px] text-muted">Sin ventas en el periodo.</p>}
            </section>
          </div>
          <p className="text-[12.5px] text-muted">Detalle y descarga en <Link to="/analytics" className="font-semibold text-accent underline">Analítica</Link>.</p>
        </>
      ) : null}
    </section>
  );
}
