import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { ScheduledMessage } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
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
  return (
    <section aria-label="Mensajes programados" className="grid gap-1.5">
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los mensajes programados.')}</Alert> : null}
      {items.length === 0 && !q.isError ? <p className="py-2 text-[13px] text-muted">No hay mensajes programados. Usa «Programar» en el redactor.</p> : null}
      {items.length > 0 ? <ul className="grid gap-1.5">{items.map((s) => <Item key={s.id} s={s} conversationId={conversationId} />)}</ul> : null}
    </section>
  );
}

/**
 * Botón de reloj de la cabecera del hilo (M5.9): SIEMPRE está, con el contador de los pendientes, y abre la lista de mensajes programados de la conversación (o el aviso de que no
 * hay ninguno). Antes la lista solo aparecía sobre el redactor cuando había alguno.
 */
export function ScheduledButton({ conversationId }: { conversationId: string }) {
  const q = useScheduledMessages(conversationId);
  const [open, setOpen] = useState(false);
  const pending = (q.data?.items ?? []).filter((s) => s.status === 'scheduled').length;
  return (
    <>
      <button
        type="button"
        aria-label={pending > 0 ? `Mensajes programados (${pending} pendientes)` : 'Mensajes programados'}
        title="Mensajes programados"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="relative grid size-11 place-items-center rounded-full border border-transparent text-muted transition hover:bg-surface2 hover:text-fg"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" /><path d="M12 7v5l3 2" /></svg>
        {pending > 0 ? <span aria-hidden="true" className="absolute right-0.5 top-0.5 grid min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[10.5px] font-bold leading-[18px] text-accent-ink">{pending}</span> : null}
      </button>
      {open ? (
        <Modal title="Mensajes programados" onClose={() => setOpen(false)} wide>
          <ScheduledList conversationId={conversationId} />
          <div className="flex justify-end"><Button onClick={() => setOpen(false)}>Cerrar</Button></div>
        </Modal>
      ) : null}
    </>
  );
}
