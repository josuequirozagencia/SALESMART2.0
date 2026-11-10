import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import type { Conversation } from '../../lib/types';
import { Button } from '../../ui/controls';
import { DeleteConversationDialog } from './DeleteConversationDialog';
import { ScheduledDialog } from './ScheduledList';
import { SheetButton, Tile } from './SheetButton';
import { TransferDialog } from './TransferDialog';
import { useConversationAction, useFavorite, useRevoke, useScheduledMessages } from './useInbox';

/**
 * Las acciones de la conversación en el panel del contacto del chat móvil (v10): antes vivían en la hoja del ⋮; ahora el ⋮ y el nombre abren el MISMO panel, que las trae en su estilo de tarjeta.
 * Tres piezas independientes (cada una con su propio estado y sus diálogos): lo principal (aceptar o asignarme), las tarjetas de la cuadrícula (transferir y programados) y lo que cierra
 * o borra (en rojo, al final). Cada acción que cambia la conversación cierra el panel; los permisos son los mismos de antes (`c.can`) y el servidor los vuelve a verificar.
 */

/** «Aceptar» o «Asignarme», la acción principal de una conversación que aún no es de quien la mira. */
export function PrimaryActions({ c, onClose, onError }: { c: Conversation; onClose: () => void; onError: (m: string | undefined) => void }) {
  const act = useConversationAction(c.id);
  const run = (a: 'accept' | 'take', fallback: string): void => {
    onError(undefined);
    act.mutate(a, { onError: (e) => onError(friendlyError(e, fallback)) });
    onClose();
  };
  if (!c.can.accept && !c.can.take) return null;
  return (
    <>
      {c.can.accept ? <Button variant="primary" className="w-full justify-center" loading={act.isPending} onClick={() => run('accept', 'No pudimos aceptar la conversación.')}>Aceptar</Button> : null}
      {c.can.take ? <Button variant="primary" className="w-full justify-center" loading={act.isPending} onClick={() => run('take', 'No pudimos asignarte la conversación.')}>Asignarme</Button> : null}
    </>
  );
}

/** «Transferir o compartir» y «Mensajes programados» como tarjetas de la cuadrícula (con su cuenta de pendientes). */
export function ActionTiles({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const navigate = useNavigate();
  const [transfer, setTransfer] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const scheduled = useScheduledMessages(c.id);
  const fav = useFavorite(c.id);
  const pending = (scheduled.data?.items ?? []).filter((m) => m.status === 'scheduled').length;
  return (
    <>
      <Tile icon="star" label={c.favorite ? 'Quitar de destacadas' : 'Destacar'} onClick={() => fav.mutate(!c.favorite)} />
      {c.can.transfer || c.can.share ? <Tile icon="swap" label="Transferir o compartir" onClick={() => setTransfer(true)} /> : null}
      <Tile icon="clock" label={pending > 0 ? `Mensajes programados (${pending})` : 'Mensajes programados'} onClick={() => setScheduledOpen(true)} />
      {transfer ? <TransferDialog c={c} onClose={() => setTransfer(false)} onTransferred={(r) => { setTransfer(false); if (!r.still_visible) navigate('/inbox'); else onClose(); }} /> : null}
      {scheduledOpen ? <ScheduledDialog conversationId={c.id} onClose={() => setScheduledOpen(false)} /> : null}
    </>
  );
}

/** Lo que deja la conversación o la borra, como filas en rojo al final del panel: «Dejar de participar», «Finalizar la conversación» y «Eliminar la conversación» (esta pide confirmación en su diálogo). */
export function DangerRows({ c, meId, onClose, onError }: { c: Conversation; meId: string; onClose: () => void; onError: (m: string | undefined) => void }) {
  const navigate = useNavigate();
  const act = useConversationAction(c.id);
  const leave = useRevoke(c.id);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const collaborator = c.my_access === 'collaborator_reply' || c.my_access === 'collaborator_view';
  if (!collaborator && !c.can.close && !c.can.delete) return null;
  return (
    <div className="grid gap-1 border-t border-line px-3 py-3">
      {confirm ? (
        <div role="alertdialog" aria-label="Finalizar la conversación" className="grid gap-2 rounded-xl border border-crit bg-crit-soft p-3 text-[13px] text-crit">
          <p>¿Finalizar? Si el cliente escribe de nuevo se abrirá otra conversación.</p>
          <div className="flex gap-2">
            <Button variant="danger" className="flex-1" loading={act.isPending} onClick={() => { onError(undefined); act.mutate('close', { onError: (e) => onError(friendlyError(e, 'No pudimos finalizar la conversación.')) }); onClose(); }}>Sí, finalizar</Button>
            <Button className="flex-1" onClick={() => setConfirm(false)}>No</Button>
          </div>
        </div>
      ) : null}
      {collaborator ? <SheetButton icon="logout" onClick={() => { onClose(); onError(undefined); leave.mutate(meId, { onSuccess: () => navigate('/inbox'), onError: (e) => onError(friendlyError(e, 'No pudimos quitarte de la conversación.')) }); }}>Dejar de participar</SheetButton> : null}
      {c.can.close && !confirm ? <SheetButton icon="check" danger onClick={() => setConfirm(true)}>Finalizar la conversación</SheetButton> : null}
      {c.can.delete ? <SheetButton icon="close" danger onClick={() => setDeleting(true)}>Eliminar la conversación</SheetButton> : null}
      {deleting ? <DeleteConversationDialog c={c} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); navigate('/inbox'); }} /> : null}
    </div>
  );
}
