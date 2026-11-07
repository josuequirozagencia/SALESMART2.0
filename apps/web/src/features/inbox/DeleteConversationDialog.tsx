import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Conversation } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useDeleteConversation } from './useInbox';

/**
 * Confirmación para eliminar una conversación (ADR-63). Dice con claridad qué pasa: desaparece de la bandeja para todos, los mensajes se conservan y queda registrado quién la eliminó.
 * El servidor vuelve a verificar el permiso (solo el administrador).
 */
export function DeleteConversationDialog({ c, onClose, onDeleted }: { c: Conversation; onClose: () => void; onDeleted: () => void }) {
  const remove = useDeleteConversation(c.id);
  const [error, setError] = useState<string>();
  return (
    <Modal title="Eliminar la conversación" onClose={onClose}>
      <p className="text-[13.5px]">
        ¿Eliminar la conversación con <b>{c.contact.name}</b>? Desaparecerá del Inbox para todo el equipo y no se podrá recuperar desde la pantalla. Los mensajes se conservan y queda registrado quién la eliminó. Si el cliente escribe de nuevo, se abrirá una conversación nueva.
      </p>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="danger" loading={remove.isPending} onClick={() => { setError(undefined); remove.mutate(undefined, { onSuccess: onDeleted, onError: (e) => setError(friendlyError(e, 'No pudimos eliminar la conversación.')) }); }}>Sí, eliminar</Button>
      </div>
    </Modal>
  );
}
