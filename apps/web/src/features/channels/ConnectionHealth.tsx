import { friendlyError } from '../../lib/errors';
import { durationLabel, shortDateTime } from '../../lib/format';
import { useRealtimeStatus } from '../../lib/realtime';
import { useRealtimeStats } from '../../lib/realtimeStats';
import { useNow } from '../../lib/useNow';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill, type PillKind } from '../../ui/Pill';
import { useConnectionHealth, useRetryEvent, type ConnectionHealth as Health, type HealthLevel, type HealthReason, type IgnoredReason } from './useConnectionHealth';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';
const n = (v: number): string => v.toLocaleString('es-EC');

const LEVEL: Record<HealthLevel, { kind: PillKind; label: string }> = { ok: { kind: 'ok', label: 'Todo bien' }, warn: { kind: 'warn', label: 'Atención' }, crit: { kind: 'crit', label: 'Requiere acción' } };
const KIND_LABEL: Record<Health['kind'], string> = { whatsapp_official: 'WhatsApp oficial', whatsapp_qr: 'WhatsApp por QR', ghl: 'GoHighLevel' };
export const IGNORED_LABEL: Record<IgnoredReason, string> = {
  group: 'Grupos',
  status: 'Estados de WhatsApp',
  from_me: 'Reacciones desde el teléfono',
  no_phone: 'Sin teléfono',
  malformed: 'Formato roto',
  receipt: 'Acuses de lectura',
  unsupported: 'Eventos que no usamos',
};

/** Una frase por cada motivo, con la cifra que lo explica. */
function reasonText(r: HealthReason, c: Health): string {
  switch (r) {
    case 'session_down': return 'La sesión de WhatsApp está caída: vuelve a vincular el número.';
    case 'failed': return `Hay ${c.events.failed} ${c.events.failed === 1 ? 'aviso que no se pudo procesar' : 'avisos que no se pudieron procesar'}. Puedes reintentarlos abajo.`;
    case 'lag': return `Los mensajes están entrando con ${durationLabel(c.recent_lag_median_s ?? 0)} de retraso (mediana de los últimos 30 min) respecto a la hora de WhatsApp. Suele ser el teléfono o el servidor de WhatsApp, no tu plataforma.`;
    case 'backlog': return `Hay ${c.events.overdue} ${c.events.overdue === 1 ? 'aviso esperando' : 'avisos esperando'} procesarse hace más de 1 minuto.`;
    case 'silent': return 'Lleva horas sin recibir ningún aviso en tu horario de atención. Revisa que el teléfono tenga internet y que la sesión siga vinculada.';
  }
}

function Lag({ s }: { s: number | null }) {
  return <>{s === null ? '—' : s < 1 ? 'menos de 1 s' : s < 60 ? `${Math.round(s)} s` : durationLabel(s)}</>;
}

function Card({ c, now }: { c: Health; now: number }) {
  const retry = useRetryEvent();
  const lvl = LEVEL[c.level];
  const last = c.last_event_at ? Math.max(0, Math.round((now - new Date(c.last_event_at).getTime()) / 1000)) : null;
  const ignored = (Object.entries(c.ignored_24h) as Array<[IgnoredReason, number]>).filter(([, v]) => v > 0);
  return (
    <article aria-label={`Salud de ${c.name}`} className="grid gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <span className="text-[15px] font-bold">{c.name}</span>
          <span className="text-[12.5px] text-muted">{KIND_LABEL[c.kind]}{c.status !== 'active' ? ' · desactivada' : ''}</span>
        </div>
        <Pill kind={c.status === 'active' ? lvl.kind : 'muted'}>{c.status === 'active' ? lvl.label : 'Desactivada'}</Pill>
      </div>
      {c.reasons.length > 0 ? (
        <ul className="grid gap-1.5 text-[13px]">
          {c.reasons.map((r) => <li key={r} className={`rounded-lg px-2.5 py-1.5 ${c.level === 'crit' ? 'bg-crit-soft text-crit' : 'bg-warn-soft text-warn'}`}>{reasonText(r, c)}</li>)}
        </ul>
      ) : null}
      <dl className="grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">
        <div className="flex gap-1.5"><dt className="text-muted">Último aviso</dt><dd>{last === null ? 'ninguno todavía' : last < 60 ? 'hace menos de 1 min' : `hace ${durationLabel(last)}`}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Mensajes recibidos (24 h)</dt><dd className="font-mono">{n(c.inbound_24h.count)}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Retraso mediano (24 h)</dt><dd><Lag s={c.inbound_24h.lag_median_s} /></dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Retraso P95 / máximo</dt><dd><Lag s={c.inbound_24h.lag_p95_s} /> / <Lag s={c.inbound_24h.lag_max_s} /></dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Avisos pendientes</dt><dd className="font-mono">{n(c.events.pending)}{c.events.overdue > 0 ? ` (${n(c.events.overdue)} atrasados)` : ''}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Avisos fallidos (7 días)</dt><dd className="font-mono">{n(c.events.failed)}</dd></div>
      </dl>
      {ignored.length > 0 ? (
        <p className="text-[12px] text-muted">Ignorados en 24 h: {ignored.map(([k, v]) => `${IGNORED_LABEL[k]} ${n(v)}`).join(' · ')}.</p>
      ) : null}
      {c.failed_events.length > 0 ? (
        <ul aria-label={`Avisos fallidos de ${c.name}`} className="grid gap-2">
          {c.failed_events.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-[12.5px]">
              <span className="grid gap-0.5"><b>{shortDateTime(f.received_at)} · {f.attempts} intentos</b><span className="text-muted">{f.reason}</span></span>
              {f.retryable
                ? <Button className={SMALL} loading={retry.isPending && retry.variables === f.id} onClick={() => retry.mutate(f.id)} aria-label={`Reintentar el aviso de ${shortDateTime(f.received_at)}`}>Reintentar</Button>
                : <span className="text-[12px] text-muted">Ya no se puede reintentar (su contenido se borró por privacidad).</span>}
            </li>
          ))}
        </ul>
      ) : null}
      {retry.isError ? <Alert>{friendlyError(retry.error, 'No pudimos reintentar el aviso.')}</Alert> : null}
    </article>
  );
}

const REALTIME_LABEL = { off: 'Apagado', connecting: 'Conectando…', live: 'En vivo', down: 'Sin conexión (consulta cada pocos segundos)' } as const;

/** Lo que ESTE navegador ve del tiempo real: sirve para saber si los mensajes llegan a la pantalla al instante o solo por la consulta de respaldo. */
function BrowserRealtime({ now }: { now: number }) {
  const status = useRealtimeStatus();
  const st = useRealtimeStats();
  const last = st.lastEventAt === null ? null : Math.max(0, Math.round((now - st.lastEventAt) / 1000));
  return (
    <section aria-label="Tiempo real en tu navegador" className="grid gap-1.5 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-bold">Tiempo real en tu navegador</h3>
        <Pill kind={status === 'live' ? 'ok' : status === 'down' ? 'crit' : 'muted'}>{REALTIME_LABEL[status]}</Pill>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">
        <div className="flex gap-1.5"><dt className="text-muted">Avisos recibidos en esta sesión</dt><dd className="font-mono">{n(st.events)}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Último aviso</dt><dd>{last === null ? 'ninguno todavía' : last < 60 ? 'hace menos de 1 min' : `hace ${durationLabel(last)}`}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Demora del aviso (mediana / máxima)</dt><dd>{st.lagMedianMs === null ? '—' : `${(st.lagMedianMs / 1000).toFixed(1)} s / ${((st.lagMaxMs ?? 0) / 1000).toFixed(1)} s`}</dd></div>
        <div className="flex gap-1.5"><dt className="text-muted">Mensajes que tardaron en aparecer</dt><dd className="font-mono">{n(st.missingRetries)}{st.missingGaveUp > 0 ? ` (${n(st.missingGaveUp)} sin resolver)` : ''}</dd></div>
      </dl>
      <p className="text-[12px] text-muted">La demora es aproximada (depende del reloj de este equipo). Si el estado no es «En vivo», las pantallas se actualizan solas por consulta cada pocos segundos.</p>
    </section>
  );
}

/**
 * Salud de las conexiones (v19 B1, dentro de Configuración › Conexiones): para cada conexión de WhatsApp o GoHighLevel, el último aviso recibido, cuánto tardan en entrar los mensajes frente a la hora de WhatsApp,
 * los avisos pendientes y fallidos —con su motivo y «Reintentar»—, lo que se ignora por motivo, y qué ve este navegador del tiempo real. Solo cifras: nada de teléfonos ni textos de clientes.
 */
export function ConnectionHealth() {
  const q = useConnectionHealth();
  const now = useNow(30_000);
  const list = q.data?.connections ?? [];
  const worst = list.some((c) => c.status === 'active' && c.level === 'crit') ? 'crit' : list.some((c) => c.status === 'active' && c.level === 'warn') ? 'warn' : 'ok';
  return (
    <section aria-label="Salud de las conexiones" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-bold uppercase tracking-wide text-muted">Salud de las conexiones</h2>
        {q.isSuccess && list.length > 0 ? <Pill kind={LEVEL[worst].kind}>{worst === 'ok' ? 'Todas bien' : worst === 'warn' ? 'Hay conexiones con atención' : 'Hay conexiones que requieren acción'}</Pill> : null}
      </div>
      {q.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando la salud de las conexiones" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar la salud de las conexiones.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && list.length === 0 ? <p className="text-[13px] text-muted">Cuando conectes un número aparecerá aquí cuánto tardan sus mensajes y si hay avisos con problemas.</p> : null}
      {list.length > 0 ? <div className="grid gap-3 lg:grid-cols-2">{list.map((c) => <Card key={c.id} c={c} now={now} />)}</div> : null}
      <BrowserRealtime now={now} />
    </section>
  );
}
