import { friendlyError } from '../../lib/errors';
import type { Conversation, ScheduledMessage } from '../../lib/types';
import { whenIn } from '../../lib/zone';
import { Alert, Button } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { personName } from './inboxFormat';
import { REASON_TEXT } from './ScheduledList';
import { useCancelScheduled, useScheduledMessages, useSendScheduledNow } from './useInbox';

/** Lo que el chat muestra de los mensajes programados: los pendientes y los que no salieron por un motivo que la persona debe conocer (no los que ella misma canceló). */
export function visibleScheduled(items: readonly ScheduledMessage[]): ScheduledMessage[] {
  return items.filter((s) => s.status === 'scheduled' || s.status === 'failed' || (s.status === 'cancelled' && s.reason !== 'cancelled_by_user'));
}

/** Los mensajes programados de la conversación, ya filtrados para el hilo, y la zona horaria de la empresa con que se dice su hora. */
export function useThreadScheduled(conversationId: string): { items: ScheduledMessage[]; timeZone: string } {
  const q = useScheduledMessages(conversationId);
  return { items: visibleScheduled(q.data?.items ?? []), timeZone: q.data?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function Bubble({ s, c, timeZone }: { s: ScheduledMessage; c: Conversation; timeZone: string }) {
  const send = useSendScheduledNow(c.id);
  const cancel = useCancelScheduled(c.id);
  const pending = s.status === 'scheduled';
  const when = whenIn(s.send_at, timeZone);
  const error = send.isError ? friendlyError(send.error, 'No pudimos enviar el mensaje ahora.') : cancel.isError ? friendlyError(cancel.error, 'No pudimos cancelar el mensaje.') : null;
  return (
    <li className="mt-2.5 flex justify-end">
      <div
        role="group"
        aria-label={pending ? `Mensaje programado para ${when}` : 'Mensaje programado que no salió'}
        className={`grid w-fit max-w-[min(80%,420px)] gap-1.5 rounded-2xl border-2 border-dashed px-3 py-2 text-[13px] ${pending ? 'border-accent/60 bg-surface text-fg' : 'border-crit bg-crit-soft text-fg'}`}
      >
        <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] font-semibold text-muted">
          <Icon name="clock" size={13} />
          <span>{pending ? `Mensaje programado · ${when}` : `Mensaje programado · no salió (${when})`}</span>
          {s.mine ? null : <span>· {personName(s.author.name)}</span>}
        </p>
        <p className="whitespace-pre-wrap break-words">{s.text}</p>
        {!pending ? <p className="text-[12px] text-muted">{REASON_TEXT[s.reason ?? ''] ?? 'No salió.'}</p> : null}
        {pending && s.can_cancel ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" className="!px-3 !py-1 !text-[12px]" aria-label={`Enviar ahora el mensaje programado para ${when}`} loading={send.isPending} disabled={cancel.isPending || !c.can.reply} onClick={() => send.mutate(s.id)}>Enviar ahora</Button>
            <Button className="!px-3 !py-1 !text-[12px]" aria-label={`Cancelar el mensaje programado para ${when}`} loading={cancel.isPending} disabled={send.isPending} onClick={() => cancel.mutate(s.id)}>Cancelar</Button>
          </div>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
      </div>
    </li>
  );
}

/**
 * Los mensajes programados DENTRO del chat (v13 S2.4): al final del hilo, con borde punteado, el reloj y «Mensaje programado · {día} {hora}» (hora de la empresa), más «Enviar ahora» y «Cancelar» para
 * quien lo programó o quien ve todo. Al salir pasan a ser un mensaje normal del hilo; se actualizan en tiempo real (`scheduled.updated`). Los que no salieron por un motivo ajeno a la persona
 * (ventana cerrada, el cliente escribió antes…) se muestran 24 h con ese motivo, porque ya no hay otro lugar donde verlo.
 */
export function ScheduledBubbles({ c, items, timeZone }: { c: Conversation; items: ScheduledMessage[]; timeZone: string }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Mensajes programados de esta conversación" className="grid">
      {items.map((s) => <Bubble key={s.id} s={s} c={c} timeZone={timeZone} />)}
    </ul>
  );
}
