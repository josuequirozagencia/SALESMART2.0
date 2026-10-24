import { useState } from 'react';
import { saveBlob } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { money, shortDate, shortDateTime } from '../../lib/format';
import { Alert, Button, Spinner } from '../../ui/controls';
import { exportReport, PERIODS, useAdvisorExport, useExportsLog, usePeriod, useRefreshExports, useReport, useSetAdvisorExport, type Report, type ReportColumn, type ReportName } from './useAnalytics';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-[9px] text-[13.5px] font-normal text-fg';
type TabName = ReportName | 'downloads';
const TABS: ReadonlyArray<{ name: ReportName; label: string }> = [
  { name: 'sales', label: 'Ventas' },
  { name: 'appointments', label: 'Citas' },
  { name: 'funnel', label: 'Embudo' },
  { name: 'advisors', label: 'Asesores' },
];
const REPORT_LABEL: Record<ReportName, string> = { sales: 'Ventas', appointments: 'Citas', funnel: 'Embudo', advisors: 'Asesores' };

/** El texto de una celda según el tipo de su columna (dinero con la moneda de la empresa, personas por su nombre). */
function cell(col: ReportColumn, value: unknown, currency: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (col.type === 'money') return money(String(value), currency);
  if (col.type === 'person') return typeof value === 'object' && value && 'name' in value ? String((value as { name: string }).name) || '—' : String(value);
  return String(value);
}

function ReportTable({ r }: { r: Report }) {
  const right = (c: ReportColumn): string => (c.type === 'money' || c.type === 'number' ? 'text-right font-mono' : '');
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full min-w-[640px] text-[13px]">
        <caption className="sr-only">{r.title}</caption>
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-muted">
            {r.columns.map((c) => <th key={c.key} scope="col" className={`px-3 py-2 font-semibold ${right(c)}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {r.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${right(c)}`}>{cell(c, row[c.key], r.currency)}</td>)}
            </tr>
          ))}
        </tbody>
        {r.totals ? (
          <tfoot>
            <tr className="border-t border-line bg-surface2 font-semibold">
              {r.columns.map((c, i) => <td key={c.key} className={`px-3 py-2 ${right(c)}`}>{r.totals![c.key] !== undefined ? cell(c, r.totals![c.key], r.currency) : i === 0 ? 'Total' : ''}</td>)}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

/**
 * «Descargas» (solo quien administra): el interruptor que permite o no la descarga de reportes al asesor y el registro de cada descarga con quién la hizo. El servidor vuelve a
 * exigir ambas cosas; esto solo lo muestra.
 */
function Downloads() {
  const setting = useAdvisorExport(true);
  const toggle = useSetAdvisorExport();
  const log = useExportsLog(true);
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  const on = setting.data?.advisor_export;
  return (
    <div className="grid gap-4">
      <section aria-label="Permiso de descarga" className="grid gap-2 rounded-2xl border border-line bg-surface p-4">
        <label className="flex items-start gap-2 text-[13.5px]">
          <input type="checkbox" role="switch" aria-label="Permitir que los asesores descarguen reportes" className="mt-1" checked={on ?? true} disabled={on === undefined || toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
          <span>
            <b>Permitir que los asesores descarguen reportes</b>
            <span className="block text-[12px] text-muted">{on === false ? 'Desactivado: los asesores siguen viendo su tablero, pero no pueden descargar el CSV. Tú sí puedes.' : 'Activado: el asesor descarga solo lo suyo. Cada descarga queda registrada aquí abajo.'}</span>
          </span>
        </label>
        {setting.isError ? <Alert>{friendlyError(setting.error, 'No se pudo leer el permiso')}</Alert> : null}
        {toggle.isError ? <Alert>{friendlyError(toggle.error, 'No se pudo cambiar el permiso')}</Alert> : null}
      </section>
      <section aria-label="Registro de descargas" className="grid gap-2">
        <h2 className="text-[15px] font-bold">Registro de descargas</h2>
        {log.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando las descargas" /></div> : null}
        {log.isError ? <Alert>{friendlyError(log.error, 'No se pudo cargar el registro')}</Alert> : null}
        {log.isSuccess && items.length === 0 ? <p className="py-6 text-center text-[13.5px] text-muted">Todavía nadie ha descargado un reporte.</p> : null}
        {items.length > 0 ? (
          <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full min-w-[640px] text-[13px]">
              <caption className="sr-only">Descargas de reportes</caption>
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-muted">
                  {['Fecha', 'Persona', 'Reporte', 'Periodo', 'Filas', 'Alcance'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="px-3 py-2">{shortDateTime(r.at)}</td>
                    <td className="px-3 py-2">{r.by?.name || '—'}</td>
                    <td className="px-3 py-2">{REPORT_LABEL[r.report]}</td>
                    <td className="px-3 py-2">{shortDate(r.from)} – {shortDate(new Date(new Date(r.to).getTime() - 1).toISOString())}</td>
                    <td className="px-3 py-2 font-mono">{r.rows}</td>
                    <td className="px-3 py-2">{r.scope === 'all' ? 'Toda la empresa' : 'Solo lo suyo'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {log.hasNextPage ? <div><Button loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>Cargar más</Button></div> : null}
      </section>
    </div>
  );
}

/**
 * Analítica (M6.5, ADR-51): cuatro reportes (ventas, citas, embudo y asesores) del periodo elegido, en la hora de la empresa. El asesor ve lo suyo; el administrador, todo. Descargar
 * el CSV lo puede hacer quien el servidor autorice (el asesor solo si el administrador lo permite) y cada descarga queda registrada; el administrador ve ese registro en «Descargas».
 */
export function AnalyticsPage() {
  const [tab, setTab] = useState<TabName>('sales');
  const [days, setDays] = useState(30);
  const period = usePeriod(days);
  const report: ReportName = tab === 'downloads' ? 'sales' : tab;
  const q = useReport(report, period);
  const canExport = q.data?.access.export === true;
  const canManage = q.data?.access.manage === true;
  const refreshLog = useRefreshExports();
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();

  const download = (): void => {
    setError(undefined);
    setExporting(true);
    exportReport(report, period)
      .then((d) => { saveBlob(d); void refreshLog(); })
      .catch((e: unknown) => setError(friendlyError(e, 'No se pudo descargar el reporte')))
      .finally(() => setExporting(false));
  };

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[20px] font-bold">Analítica</h1>
        {tab !== 'downloads' ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[13px]">Periodo
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={selectCls}>
                {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
              </select>
            </label>
            {canExport ? <Button loading={exporting} onClick={download}>Descargar CSV</Button> : null}
          </div>
        ) : null}
      </div>
      <div role="tablist" aria-label="Reportes" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button key={t.name} type="button" role="tab" aria-selected={tab === t.name} onClick={() => setTab(t.name)} className={`-mb-px border-b-2 px-3 py-2 text-[13.5px] font-semibold ${tab === t.name ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}>{t.label}</button>
        ))}
        {canManage ? (
          <button type="button" role="tab" aria-selected={tab === 'downloads'} onClick={() => setTab('downloads')} className={`-mb-px border-b-2 px-3 py-2 text-[13.5px] font-semibold ${tab === 'downloads' ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}>Descargas</button>
        ) : null}
      </div>
      {tab === 'downloads' ? <Downloads /> : (
        <>
          {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando el reporte" /></div> : null}
          {q.isError ? <Alert>{friendlyError(q.error, 'No se pudo cargar el reporte')}</Alert> : null}
          {error ? <Alert>{error}</Alert> : null}
          {q.data ? (
            <>
              <p className="text-[12.5px] text-muted">{q.data.rows.length} fila(s) · hora de {q.data.timezone}</p>
              {q.data.truncated ? <Alert kind="info">El reporte tiene más filas de las que se muestran; descarga el CSV o acorta el periodo.</Alert> : null}
              {q.data.rows.length === 0 ? <p className="py-8 text-center text-[13.5px] text-muted">No hay datos en este periodo.</p> : <ReportTable r={q.data} />}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
