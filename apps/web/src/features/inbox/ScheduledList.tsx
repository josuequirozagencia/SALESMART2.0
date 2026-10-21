import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { ScheduledMessage } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { useCancelScheduled, useScheduledMessages } from './useInbox';

/** Por qué un mensaje programado no salió, en palabras de quien lo programó. */
export const REASON_TEXT: Record<string, string> = {
  cancelled_by_user: 'Se canceló.',
  customer_replied: 'Se canceló porque el cliente escribió antes.',
  conversation_closed: 'Se canceló porque la conversación se finalizó.',
  conversation_changed: 'Se canceló porque cambió quién atiende la conversación.',
  not_allowed: 'Se canceló porque quien lo programó ya no puede responder esta conversación.',
  window_closed: 'No salió: se cerró la ventana de 24 h de WhatsApp. Ahora solo valen plantillas.',
  channel_unavailable: 'No salió: la conexión de WhatsApp estaba desactivada.',
  error: 'No salió por un problema del sistema.',
};

function Item({ s, conversationId }: { s: ScheduledMessage; conversationId: string }) {
  const cancel = useCancelScheduled(conversationId);
  const pending = s.status === 'scheduled';
  return (
    <li className={`grid gap-1 rounded-xl border px-3 py-2 text-[13px] ${pending ? 'border-line bg-surface' : 'border-line bg-surface2'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-1.5">
          <Pill kind={pending ? 'info' : s.status === 'failed' ? 'crit' : 'muted'}>{pending ? 'Programado' : s.status === 'failed' ? 'No salió' : 'Cancelado'}</Pill>
          <b>{shortDateTime(s.send_at)}</b>
          {s.mine ? null : <span className="text-muted">· {s.author.name}</span>}
        </span>
        {s.can_cancel ? <Button className="!px-3 !py-1 !text-[12px]" aria-label={`Cancelar el mensaje programado para ${shortDateTime(s.send_at)}`} loading={cancel.isPending} onClick={() => cancel.mutate(s.id)}>Cancelar</Button> : null}
      </div>
      <p className="line-clamp-2 whitespace-pre-wrap text-muted">{s.text}</p>
      {!pending && s.reason ? <p className="text-[12px] text-muted">{REASON_TEXT[s.reason] ?? 'No salió.'}</p> : null}
      {cancel.isError ? <Alert>{friendlyError(cancel.error, 'No pudimos cancelar el mensaje.')}</Alert> : null}
    </li>
  );
}

/** Los mensajes programados de la conversación: los pendientes con su hora y, por 24 h, los que no salieron con el motivo. */
export function ScheduledList({ conversationId }: { conversationId: string }) {
  const q = useScheduledMessages(conversationId);
  const items = q.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-label="Mensajes programados" className="grid gap-1.5">
      <ul className="grid gap-1.5">{items.map((s) => <Item key={s.id} s={s} conversationId={conversationId} />)}</ul>
    </section>
  );
}
