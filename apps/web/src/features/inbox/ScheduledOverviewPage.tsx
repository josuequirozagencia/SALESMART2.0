import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { ScheduledListItem } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { personName } from './inboxFormat';
import { REASON_TEXT } from './ScheduledList';
import { useAllScheduled, useCancelScheduledAny, type ScheduledView } from './useInbox';

function Row({ s }: { s: ScheduledListItem }) {
  const cancel = useCancelScheduledAny();
  const pending = s.status === 'scheduled';
  const pill = pending ? { kind: 'info' as const, text: 'Programado' } : s.status === 'sent' ? { kind: 'ok' as const, text: 'Enviado' } : s.status === 'failed' ? { kind: 'crit' as const, text: 'No salió' } : { kind: 'muted' as const, text: 'Cancelado' };
  return (
    <li className="grid gap-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Pill kind={pill.kind}>{pill.text}</Pill>
          <b>{shortDateTime(s.send_at)}</b>
          <span className="min-w-0 truncate font-semibold">{s.conversation.contact.name}</span>
          <span className="text-muted">· {s.conversation.channel_name}{s.mine ? '' : ` · ${personName(s.author.name)}`}</span>
        </span>
        <span className="flex items-center gap-2">
          <Link to={`/inbox/${s.conversation.id}`} className="inline-flex min-h-9 items-center rounded-[10px] border border-line px-3 py-1 text-[12px] font-semibold text-accent hover:bg-surface2" aria-label={`Ir al chat con ${s.conversation.contact.name}`}>Ir al chat</Link>
          {s.can_cancel ? (
            <Button className="!px-3 !py-1 !text-[12px]" aria-label={`Cancelar el mensaje programado para ${s.conversation.contact.name}`} loading={cancel.isPending} onClick={() => cancel.mutate({ conversationId: s.conversation.id, id: s.id })}>Cancelar</Button>
          ) : null}
        </span>
      </div>
      <p className="line-clamp-2 whitespace-pre-wrap text-muted">{s.text}</p>
      {!pending && s.status !== 'sent' && s.reason ? <p className="text-[12px] text-muted">{REASON_TEXT[s.reason] ?? 'No salió.'}</p> : null}
      {cancel.isError ? <Alert>{friendlyError(cancel.error, 'No pudimos cancelar el mensaje.')}</Alert> : null}
    </li>
  );
}

/** Un día elegido en un campo de fecha (`AAAA-MM-DD`) como instante: el principio o el final de ese día, en la hora de este navegador. */
function dayBound(day: string, end: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T${end ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const VIEWS: Array<{ id: ScheduledView; label: string }> = [
  { id: 'scheduled', label: 'Programados' },
  { id: 'sent', label: 'Enviados' },
  { id: 'not_sent', label: 'No salieron' },
];
const dateCls = 'rounded-[10px] border border-line bg-surface px-3 py-1.5 text-[13px] font-normal';

/**
 * Mensajes programados de todas las conversaciones (M5.10; desde v13 S2.3 viven en Tareas, pestaña «Mensajes programados»): lo pendiente por hora de envío y, 24 h, lo que ya salió o no salió con
 * su motivo. Cada fila abre su chat («Ir al chat») y se puede cancelar desde aquí. Filtros: «Solo los míos», un rango de fechas de envío y, con `?contact=<id>`, un contacto. El alcance lo decide el
 * servidor, igual que el de la bandeja.
 */
export function ScheduledMessagesPanel() {
  const [view, setView] = useState<ScheduledView>('scheduled');
  const [mine, setMine] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [params, setParams] = useSearchParams();
  const contactId = params.get('contact') ?? undefined;
  const q = useAllScheduled(view, { mine, contactId, from: dayBound(from, false), to: dayBound(to, true) });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const counts = q.data?.pages[0]?.counts ?? null;
  const filtered = mine || from !== '' || to !== '' || contactId !== undefined;
  const clearContact = (): void => {
    const next = new URLSearchParams(params);
    next.delete('contact');
    setParams(next, { replace: true });
  };
  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted">Lo que saldrá solo en tus conversaciones. Lo que salió o no salió se muestra 24 horas.</p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div role="tablist" aria-label="Estado de los mensajes programados" className="flex flex-wrap gap-1">
          {VIEWS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={view === t.id} onClick={() => setView(t.id)} className={`rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${view === t.id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>
              {t.label}{counts ? ` (${counts[t.id]})` : ''}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-[12px] font-semibold">Desde
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={dateCls} />
          </label>
          <label className="grid gap-1 text-[12px] font-semibold">Hasta
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={dateCls} />
          </label>
          <label className="flex items-center gap-2 pb-2 text-[13px]">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
            Solo los que programé yo
          </label>
        </div>
      </div>
      {contactId ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px]">
          <Pill kind="accent">Solo un contacto</Pill>
          <Button variant="link" onClick={clearContact}>Quitar este filtro</Button>
        </p>
      ) : null}
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando mensajes programados" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los mensajes programados.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] text-muted">
          {filtered ? 'No hay mensajes con esos filtros.' : view === 'scheduled' ? 'No hay mensajes programados. Usa el reloj del redactor en una conversación.' : view === 'sent' ? 'No ha salido ningún mensaje programado en las últimas 24 horas.' : 'No hay mensajes que no hayan salido en las últimas 24 horas.'}
        </p>
      ) : null}
      {items.length > 0 ? <ul aria-label={view === 'scheduled' ? 'Mensajes programados' : view === 'sent' ? 'Mensajes programados que salieron' : 'Mensajes que no salieron'} className="grid gap-1.5">{items.map((s) => <Row key={s.id} s={s} />)}</ul> : null}
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}
    </div>
  );
}
