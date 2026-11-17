import { Link } from 'react-router-dom';
import { Spinner } from '../../ui/controls';
import { percent } from './labels';
import { useCampaignAccess, useCampaignsSummary } from './useCampaigns';

const n = (v: number): string => v.toLocaleString('es-EC');

function Cell({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="grid gap-0.5 rounded-xl border border-line px-3 py-2">
      <span className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">{label}</span>
      <b className="font-mono text-[20px] leading-tight">{value}</b>
      {detail ? <span className="text-[11.5px] text-muted">{detail}</span> : null}
    </div>
  );
}

/**
 * «Campañas del periodo» (v17 · 17.5): lo que dieron las campañas masivas lanzadas en el periodo de Analítica. Solo aparece si la persona puede ver campañas y su plan las incluye (no pide nada
 * si no); el asesor ve lo suyo y el administrador, toda la empresa (el servidor decide y lo informa en `scope`). El detalle por destinatario y el CSV están en Campañas › Resultados.
 */
export function CampaignsSummaryCard({ period }: { period: { from: string; to: string } }) {
  const access = useCampaignAccess();
  const enabled = access.data?.plan_enabled === true && access.data.read;
  const q = useCampaignsSummary(period, enabled);
  if (!enabled) return null;
  const s = q.data;
  return (
    <section aria-label="Campañas del periodo" className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-bold">Campañas del periodo</h2>
          {s ? <p className="text-[12.5px] text-muted">{s.scope === 'all' ? 'Las de toda la empresa' : 'Solo las tuyas'} · las lanzadas en el periodo</p> : null}
        </div>
        <Link to="/campaigns" className="text-[13px] font-semibold text-accent underline">Ver campañas</Link>
      </div>
      {q.isPending ? <div className="grid place-items-center py-4 text-muted"><Spinner label="Cargando las campañas" /></div> : null}
      {q.isError ? <p className="text-[13px] text-muted">No pudimos cargar el resumen de campañas.</p> : null}
      {s && s.campaigns === 0 ? <p className="text-[13px] text-muted">No se lanzó ninguna campaña en este periodo.</p> : null}
      {s && s.campaigns > 0 ? (
        <div className="grid grid-cols-2 gap-2 min-[560px]:grid-cols-3 lg:grid-cols-6">
          <Cell label="Campañas" value={n(s.campaigns)} detail={`${n(s.recipients)} destinatarios`} />
          <Cell label="Enviados" value={n(s.sent)} detail={s.skipped > 0 ? `${n(s.skipped)} omitidos` : undefined} />
          <Cell label="Entregados" value={n(s.delivered)} detail={`Entrega ${percent(s.delivery_rate)}`} />
          <Cell label="Respondieron" value={n(s.replied)} detail={`Respuesta ${percent(s.reply_rate)}`} />
          <Cell label="Fallidos" value={n(s.failed)} />
          <Cell label="Bajas" value={n(s.opted_out)} detail="Pidieron no recibir más" />
        </div>
      ) : null}
    </section>
  );
}
