import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { ScheduledListItem } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { REASON_TEXT } from './ScheduledList';
import { useAllScheduled, useCancelScheduledAny } from './useInbox';

type View = 'scheduled' | 'not_sent';

function Row({ s }: { s: ScheduledListItem }) {
  const cancel = useCancelScheduledAny();
  const pending = s.status === 'scheduled';
  return (
    <li className="grid gap-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Pill kind={pending ? 'info' : s.status === 'failed' ? 'crit' : 'muted'}>{pending ? 'Programado' : s.status === 'failed' ? 'No salió' : 'Cancelado'}</Pill>
          <b>{shortDateTime(s.send_at)}</b>
          <Link to={`/inbox/${s.conversation.id}`} className="min-w-0 truncate font-semibold text-accent hover:underline" aria-label={`Abrir la conversación con ${s.conversation.contact.name}`}>{s.conversation.contact.name}</Link>
          <span className="text-muted">· {s.conversation.channel_name}{s.mine ? '' : ` · ${s.author.name}`}</span>
        </span>
        {s.can_cancel ? (
          <Button className="!px-3 !py-1 !text-[12px]" aria-label={`Cancelar el mensaje programado para ${s.conversation.contact.name}`} loading={cancel.isPending} onClick={() => cancel.mutate({ conversationId: s.conversation.id, id: s.id })}>Cancelar</Button>
        ) : null}
      </div>
      <p className="line-clamp-2 whitespace-pre-wrap text-muted">{s.text}</p>
      {!pending && s.reason ? <p className="text-[12px] text-muted">{REASON_TEXT[s.reason] ?? 'No salió.'}</p> : null}
      {cancel.isError ? <Alert>{friendlyError(cancel.error, 'No pudimos cancelar el mensaje.')}</Alert> : null}
    </li>
  );
}

/**
 * Mensajes programados de todas las conversaciones (M5.10): lo pendiente por hora de envío, o lo que no salió en las últimas 24 h con el motivo. Cada fila abre su conversación y se puede
 * cancelar desde aquí. «Solo los míos» ayuda a quien ve todas las conversaciones. El alcance lo decide el servidor, igual que el de la bandeja.
 */
export function ScheduledOverviewPage() {
  const [view, setView] = useState<View>('scheduled');
  const [mine, setMine] = useState(false);
  const q = useAllScheduled(view, mine);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const counts = q.data?.pages[0]?.counts ?? null;
  const tabs: Array<{ id: View; label: string }> = [
    { id: 'scheduled', label: 'Programados' },
    { id: 'not_sent', label: 'No salieron' },
  ];
  return (
    <div className="mx-auto grid max-w-[860px] gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-[20px] font-bold">Mensajes programados</h1>
          <p className="text-[13px] text-muted">Lo que saldrá solo en tus conversaciones. Los que no salieron se muestran 24 horas.</p>
        </div>
        <Link to="/inbox" className="inline-flex items-center rounded-[10px] border border-line px-3 py-2 text-[13px] font-semibold hover:bg-surface2">← Volver al Inbox</Link>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Estado" className="flex gap-1">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={view === t.id} onClick={() => setView(t.id)} className={`rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${view === t.id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>
              {t.label}{counts ? ` (${counts[t.id]})` : ''}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Solo los que programé yo
        </label>
      </div>
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando mensajes programados" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los mensajes programados.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] text-muted">
          {view === 'scheduled' ? 'No hay mensajes programados. Usa «Programar» en el redactor de una conversación.' : 'No hay mensajes que no hayan salido en las últimas 24 horas.'}
        </p>
      ) : null}
      {items.length > 0 ? <ul aria-label={view === 'scheduled' ? 'Mensajes programados' : 'Mensajes que no salieron'} className="grid gap-1.5">{items.map((s) => <Row key={s.id} s={s} />)}</ul> : null}
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}
    </div>
  );
}
