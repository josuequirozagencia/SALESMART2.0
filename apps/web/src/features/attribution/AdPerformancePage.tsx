import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { AdPerformance, AdPerformanceRow, ContactChannel } from '../../lib/types';
import { useQuery } from '@tanstack/react-query';
import { ChannelBadge } from '../../ui/ChannelBadge';
import { Alert, Spinner } from '../../ui/controls';
import { PERIODS, usePeriod } from '../analytics/useAnalytics';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-[9px] text-[13.5px] font-normal text-fg';
const inputCls = selectCls;
const CHANNELS: ReadonlyArray<{ value: '' | ContactChannel; label: string }> = [
  { value: '', label: 'Todos los canales' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'manual', label: 'Manual' },
  { value: 'other', label: 'Otro canal' },
];
const CUSTOM = 'custom';

/** Las fechas de los selectores son días locales; el servidor recibe el inicio del primer día y el final del último. */
const dayStart = (d: string): string => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string): string => new Date(`${d}T23:59:59.999`).toISOString();
const today = (): string => new Date().toLocaleDateString('en-CA');
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA');

function useAdPerformance(p: { from: string; to: string }, channel: string, touchModel: 'last' | 'first') {
  return useQuery({
    queryKey: ['ad-performance', p.from, p.to, channel, touchModel],
    retry: false,
    queryFn: () => api<AdPerformance>(`/attribution/ad-performance?from=${encodeURIComponent(p.from)}&to=${encodeURIComponent(p.to)}&touchModel=${touchModel}${channel ? `&channel=${channel}` : ''}`),
  });
}

/** La estrella dorada del anuncio con más ventas del periodo. */
function Star() {
  return (
    <span role="img" aria-label="Anuncio con más ventas en el periodo" title="Anuncio con más ventas en el periodo" className="text-[16px] leading-none" style={{ color: '#e8a800' }}>
      ★
    </span>
  );
}

const pct = (n: number): string => `${n.toLocaleString('es', { maximumFractionDigits: 1 })} %`;
const dash = (v: string | null): string => (v && v.trim() !== '' ? v : '—');

function Table({ rows }: { rows: AdPerformanceRow[] }) {
  return (
    <div className="hidden overflow-x-auto rounded-2xl border border-line bg-surface md:block">
      <table className="w-full min-w-[760px] text-[13px]">
        <caption className="sr-only">Rendimiento de anuncios</caption>
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-muted">
            <th scope="col" className="px-3 py-2 font-semibold">Anuncio</th>
            <th scope="col" className="px-3 py-2 font-semibold">Conjunto</th>
            <th scope="col" className="px-3 py-2 font-semibold">Campaña</th>
            <th scope="col" className="px-3 py-2 font-semibold">Canal</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Leads</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Ventas</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Conv.%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              <td className="px-3 py-2 font-semibold">
                <span className="flex items-center gap-1.5">{r.isTopAd ? <Star /> : null}<span className="break-words">{dash(r.adName)}</span></span>
              </td>
              <td className="px-3 py-2">{dash(r.adsetName)}</td>
              <td className="px-3 py-2">{dash(r.campaignName)}</td>
              <td className="px-3 py-2"><ChannelBadge channel={r.channel} /></td>
              <td className="px-3 py-2 text-right font-mono">{r.leads}</td>
              <td className="px-3 py-2 text-right font-mono">{r.sales}</td>
              <td className="px-3 py-2 text-right font-mono">{pct(r.convRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** En el móvil la tabla pasa a tarjetas con lo principal. */
function Cards({ rows }: { rows: AdPerformanceRow[] }) {
  return (
    <ul className="grid gap-2 md:hidden" aria-label="Rendimiento de anuncios">
      {rows.map((r, i) => (
        <li key={i} className="grid gap-2 rounded-2xl border border-line bg-surface p-3">
          <div className="flex items-start justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-[14px] font-bold">{r.isTopAd ? <Star /> : null}<span className="break-words">{dash(r.adName)}</span></span>
            <ChannelBadge channel={r.channel} />
          </div>
          <p className="break-words text-[12px] text-muted">{dash(r.campaignName)} · {dash(r.adsetName)}</p>
          <dl className="grid grid-cols-3 gap-2 text-center">
            <div><dt className="text-[11.5px] text-muted">Leads</dt><dd className="font-mono text-[15px] font-bold">{r.leads}</dd></div>
            <div><dt className="text-[11.5px] text-muted">Ventas</dt><dd className="font-mono text-[15px] font-bold">{r.sales}</dd></div>
            <div><dt className="text-[11.5px] text-muted">Conv.%</dt><dd className="font-mono text-[15px] font-bold">{pct(r.convRate)}</dd></div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

/**
 * «Rendimiento de anuncios» (M3.3 §12): qué anuncios traen leads y ventas. Solo con el permiso `attribution.view` (el servidor lo exige: sin él responde 403 y aquí se explica). La estrella
 * dorada marca al anuncio con más ventas del periodo y solo aparece si hay al menos una venta.
 */
export function AdPerformancePage() {
  const [days, setDays] = useState<number | typeof CUSTOM>(30);
  const [customFrom, setCustomFrom] = useState(daysAgo(30));
  const [customTo, setCustomTo] = useState(today());
  const [channel, setChannel] = useState<'' | ContactChannel>('');
  const [touchModel, setTouchModel] = useState<'last' | 'first'>('last');
  const preset = usePeriod(typeof days === 'number' ? days : 30);
  const customOk = customFrom !== '' && customTo !== '' && customFrom <= customTo;
  const period = days === CUSTOM ? (customOk ? { from: dayStart(customFrom), to: dayEnd(customTo) } : preset) : preset;
  const q = useAdPerformance(period, channel, touchModel);
  const rows = q.data?.rows ?? [];
  const forbidden = q.isError && (q.error as { status?: number } | null)?.status === 403;

  return (
    <section className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-[22px] font-bold">Rendimiento de anuncios</h1>
        <p className="text-[13.5px] text-muted">Qué anuncios traen leads y cuáles terminan en venta (contactos con la etiqueta «Venta»).</p>
      </header>

      <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Filtros">
        <label className="grid gap-1 text-[12.5px] font-semibold">
          Periodo
          <select className={selectCls} value={String(days)} onChange={(e) => setDays(e.target.value === CUSTOM ? CUSTOM : Number(e.target.value))}>
            {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
            <option value={CUSTOM}>Rango libre…</option>
          </select>
        </label>
        {days === CUSTOM ? (
          <>
            <label className="grid gap-1 text-[12.5px] font-semibold">Desde<input type="date" className={inputCls} value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} /></label>
            <label className="grid gap-1 text-[12.5px] font-semibold">Hasta<input type="date" className={inputCls} value={customTo} min={customFrom} max={today()} onChange={(e) => setCustomTo(e.target.value)} /></label>
          </>
        ) : null}
        <label className="grid gap-1 text-[12.5px] font-semibold">
          Canal
          <select className={selectCls} value={channel} onChange={(e) => setChannel(e.target.value as '' | ContactChannel)}>
            {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-[12.5px] font-semibold">
          Agrupar por
          <select className={selectCls} value={touchModel} onChange={(e) => setTouchModel(e.target.value as 'last' | 'first')}>
            <option value="last">Último anuncio visto</option>
            <option value="first">Anuncio que lo trajo</option>
          </select>
        </label>
      </div>
      {days === CUSTOM && !customOk ? <Alert>La fecha inicial no puede ser posterior a la final.</Alert> : null}

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando el rendimiento de anuncios" /></div> : null}
      {forbidden ? <Alert>No tienes permiso para ver el rendimiento de anuncios. Pídele al administrador de tu empresa el permiso «Ver el rendimiento de anuncios».</Alert> : null}
      {q.isError && !forbidden ? <Alert>{friendlyError(q.error, 'No pudimos cargar el rendimiento de anuncios.')}</Alert> : null}
      {q.isSuccess && rows.length === 0 ? (
        <div className="grid gap-2 rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">
          <p>Todavía no hay datos de anuncios en este periodo.</p>
          <p>Cuando lleguen clics de anuncios de Meta, aparecerán aquí. Si aún no lo hiciste, conecta el aviso en <Link to="/settings/attribution" className="font-semibold text-accent underline">Configuración › Atribución de Meta</Link>.</p>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <>
          <Table rows={rows} />
          <Cards rows={rows} />
        </>
      ) : null}
    </section>
  );
}
