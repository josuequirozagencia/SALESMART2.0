import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSession } from '../../lib/session';
import type { InboxFilters } from '../../lib/types';
import { ConversationList } from './ConversationList';
import { Thread } from './Thread';
import { DEFAULT_INBOX_FILTERS } from './useInbox';

/**
 * Inbox (M5.4, ADR-16/50): la lista de conversaciones a la izquierda y el hilo de la abierta a la derecha. En pantallas angostas se ve una sola columna: la lista,
 * o el hilo si hay una abierta (`/inbox/:id`). Quien no ve todo recibe del servidor solo sus conversaciones. Se actualiza solo (sin tiempo real hasta M5.7).
 */
export function InboxPage() {
  const { id } = useParams();
  const { state } = useSession();
  const [filters, setFilters] = useState<InboxFilters>(DEFAULT_INBOX_FILTERS);
  const meId = state.status === 'authed' ? state.me.user.id : '';
  return (
    <div className="grid h-[calc(100dvh-290px)] min-h-[420px] grid-cols-1 lg:h-[calc(100dvh-260px)] overflow-hidden rounded-2xl border border-line bg-surface lg:grid-cols-[340px_minmax(0,1fr)]">
      <ConversationList filters={filters} onFilters={setFilters} activeId={id} className={id ? 'hidden lg:flex' : 'flex'} />
      {id ? (
        <Thread key={id} id={id} meId={meId} />
      ) : (
        <section aria-label="Conversación" className="hidden place-content-center gap-1 bg-bg p-8 text-center lg:grid">
          <b className="text-[15px]">Elige una conversación</b>
          <span className="text-[13px] text-muted">Aquí verás los mensajes y podrás responder.</span>
        </section>
      )}
    </div>
  );
}
