import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import type { Conversation } from '../../lib/types';
import { personName } from '../inbox/inboxFormat';

/** En la ficha del contacto (V24): quién atiende su conversación abierta más reciente (o la última), con enlace. Sin conversaciones visibles o sin permiso, no aparece. */
export function LatestConversation({ contactId }: { contactId: string }) {
  const q = useQuery({
    queryKey: ['contact-conversation', contactId],
    retry: false,
    staleTime: 15_000,
    queryFn: async () => {
      const { conversation_id } = await api<{ conversation_id: string }>(`/contacts/${contactId}/conversation`);
      return api<Conversation>(`/conversations/${conversation_id}`);
    },
  });
  const c = q.data;
  if (!c) return null;
  return (
    <p className="rounded-xl border border-line bg-surface2 px-3 py-2 text-[13px]">
      {c.status === 'closed' ? 'Última conversación (finalizada)' : 'Conversación abierta'}: {c.owner ? <>atendida por <b>{personName(c.owner.name)}</b></> : <b>sin asignar</b>}.{' '}
      <Link to={`/inbox/${c.id}`} className="font-semibold text-accent underline">Abrir conversación</Link>
    </p>
  );
}
