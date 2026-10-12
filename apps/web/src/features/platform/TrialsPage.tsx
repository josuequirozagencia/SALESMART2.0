import { useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDate, timeLeft } from '../../lib/format';
import type { PlatformTrialItem } from '../../lib/types';
import { useNow } from '../../lib/useNow';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { DecisionDialog, type Decision } from './DecisionDialog';
import { usePlatformTrials, type TrialFilter } from './usePlatformTrials';

const FILTERS: Array<[TrialFilter, string]> = [['pending', 'Solicitudes pendientes'], ['all', 'Todas'], ['active', 'Activas'], ['expired', 'Vencidas']];
const EMPTY: Record<TrialFilter, string> = {
  pending: 'No hay solicitudes de extensión pendientes.',
  all: 'Todavía no hay pruebas.',
  active: 'No hay pruebas activas.',
  expired: 'No hay pruebas vencidas.',
};

function StatusPill({ t, now }: { t: PlatformTrialItem; now: number }) {
  if (t.plan_name) return <Pill kind="accent">Con plan: {t.plan_name}</Pill>; // ya no está en prueba (ADR-38)
  const left = new Date(t.ends_at).getTime() - now;
  if (t.status === 'expired' || left <= 0) return <Pill kind="crit">Vencida</Pill>;
  return <Pill kind={left < 2 * 86_400_000 ? 'warn' : 'ok'}>{timeLeft(left)}</Pill>;
}

function ExtensionPill({ t }: { t: PlatformTrialItem }) {
  switch (t.extension.status) {
    case 'pending': return <Pill kind="warn">Pendiente</Pill>;
    case 'approved': return <Pill kind="ok">Aprobada{t.extension.days_granted ? ` +${t.extension.days_granted} d` : ''}</Pill>;
    case 'denied': return <Pill kind="crit">Rechazada</Pill>;
    default: return <Pill kind="muted">Sin solicitud</Pill>;
  }
}

const waLink = (phone: string): string => `https://wa.me/${phone.replace(/\D/g, '')}`;

function Row({ t, now, onDecide }: { t: PlatformTrialItem; now: number; onDecide: (d: Decision) => void }) {
  return (
    <li className="grid gap-3 rounded-2xl border border-line bg-surface p-4 min-[900px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_150px_minmax(0,1.6fr)_auto] min-[900px]:items-start">
      <div className="min-w-0">
        <b className="block truncate text-[14px]">{t.organization_name}</b>
        <span className="block truncate text-[12px] text-muted">{t.owner_email}</span>
      </div>
      <div className="min-w-0 text-[13px]">
        <span className="block truncate">{t.owner_name ?? '—'}</span>
        {t.owner_phone ? (
          <a href={waLink(t.owner_phone)} target="_blank" rel="noopener noreferrer" className="font-mono text-[12px] font-semibold text-accent hover:underline" aria-label={`Escribir por WhatsApp a ${t.owner_name ?? t.owner_email}`}>
            {t.owner_phone}
          </a>
        ) : null}
      </div>
      <div className="grid justify-items-start gap-1 text-[12px]">
        <span className="font-mono text-muted">{shortDate(t.started_at)} → {shortDate(t.ends_at)}</span>
        <StatusPill t={t} now={now} />
      </div>
      <div className="min-w-0 text-[13px]">
        <ExtensionPill t={t} />
        {t.extension.reason ? <p className="mt-1.5 text-[12px] text-muted">«{t.extension.reason}»</p> : null}
      </div>
      <div className="flex gap-2">
        {t.extension.status === 'pending' ? (
          <>
            <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Aprobar la extensión de ${t.organization_name}`} onClick={() => onDecide({ item: t, action: 'approve' })}>Aprobar</Button>
            <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Rechazar la extensión de ${t.organization_name}`} onClick={() => onDecide({ item: t, action: 'deny' })}>Rechazar</Button>
          </>
        ) : null}
      </div>
    </li>
  );
}

/** Pestaña «Pruebas» de la consola de plataforma: resumen, filtros, lista paginada y decisión sobre las extensiones. */
export function TrialsPage() {
  const [filter, setFilter] = useState<TrialFilter>('pending');
  const [decision, setDecision] = useState<Decision | null>(null);
  const q = usePlatformTrials(filter);
  const now = useNow(30_000);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const summary = q.data?.pages[0]?.summary;

  const cards: Array<[string, number | undefined]> = [['Pruebas activas', summary?.active], ['Vencen en menos de 2 días', summary?.expiring_soon], ['Solicitudes pendientes', summary?.pending]];

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 min-[640px]:grid-cols-3" aria-label="Resumen de pruebas" role="group">
        {cards.map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-line bg-surface p-4">
            <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">{label}</div>
            <div className="mt-1 font-mono text-[26px] font-semibold" data-testid={`kpi-${label}`}>{value ?? '—'}</div>
          </div>
        ))}
      </div>

      <div role="tablist" aria-label="Filtrar pruebas" className="flex flex-wrap gap-2">
        {FILTERS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)} className={`rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold ${filter === key ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-muted hover:text-fg'}`}>
            {label}{key === 'pending' && summary ? ` (${summary.pending})` : ''}
          </button>
        ))}
      </div>

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando pruebas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las pruebas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}

      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">
          {EMPTY[filter]} {filter === 'pending' ? <Button variant="link" onClick={() => setFilter('all')}>Ver todas</Button> : null}
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className="grid gap-3" aria-label="Pruebas">
          {items.map((t) => <Row key={t.id} t={t} now={now} onDecide={setDecision} />)}
        </ul>
      ) : null}

      {q.hasNextPage ? (
        <div className="grid place-items-center">
          <Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button>
        </div>
      ) : null}

      {decision ? <DecisionDialog decision={decision} extensionDays={summary?.extension_days ?? 0} now={now} onClose={() => setDecision(null)} /> : null}
    </div>
  );
}
