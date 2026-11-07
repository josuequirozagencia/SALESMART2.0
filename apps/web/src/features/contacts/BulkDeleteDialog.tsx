import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useBulkDeleteContacts } from './useContacts';

const MAX = 200;

/**
 * Confirmación del borrado masivo de contactos. Es un borrado lógico: los datos se conservan, el servidor audita cada contacto y libera sus teléfonos; sus oportunidades se borran con ellos
 * y sus conversaciones dejan de verse. Todo en una sola operación (hasta 200).
 */
export function BulkDeleteDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (r: { deleted: string[]; skipped: string[] }) => void }) {
  const remove = useBulkDeleteContacts();
  const [error, setError] = useState<string>();
  const tooMany = ids.length > MAX;
  return (
    <Modal title="Borrar contactos" onClose={onClose}>
      <p className="text-[13.5px]">
        ¿Borrar <b>{ids.length}</b> contacto{ids.length === 1 ? '' : 's'}? Sus oportunidades se borran con ellos, sus conversaciones dejan de verse y sus teléfonos quedan libres. Queda registrado quién lo hizo. Esta acción no se puede deshacer desde la pantalla.
      </p>
      {tooMany ? <Alert>Puedes borrar hasta {MAX} contactos a la vez. Quita algunos de la selección.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="danger" disabled={tooMany} loading={remove.isPending} onClick={() => { setError(undefined); remove.mutate(ids, { onSuccess: onDone, onError: (e) => setError(friendlyError(e, 'No pudimos borrar los contactos.')) }); }}>Sí, borrar</Button>
      </div>
    </Modal>
  );
}
