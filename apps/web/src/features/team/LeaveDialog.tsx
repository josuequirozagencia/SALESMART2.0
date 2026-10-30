import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { LeaveResult, TeamMember } from '../../lib/types';
import { Alert, Button, Field } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useLeaveTeam } from './useTeam';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] text-fg';

/**
 * Desactivar o quitar a una persona (M10.4, ADR-56 B3 #8). Hay que ELEGIR qué pasa con sus conversaciones abiertas —pasarlas a otra persona o dejarlas sin asignación—; no hay
 * opción por omisión. Desactivar se puede deshacer (reactivar); quitar es definitivo y nunca borra la cuenta de la persona. En ambos casos se cierran sus sesiones.
 */
export function LeaveDialog({ member, kind, people, openConversations, onClose, onDone }: { member: TeamMember; kind: 'deactivate' | 'remove'; people: TeamMember[]; openConversations: number; onClose: () => void; onDone: (r: LeaveResult) => void }) {
  const leave = useLeaveTeam(member.user_id, kind);
  const [action, setAction] = useState<'transfer' | 'unassign' | ''>('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string>();
  const targets = people.filter((p) => p.user_id !== member.user_id && p.status === 'active');
  const removing = kind === 'remove';

  function confirm() {
    setError(undefined);
    if (action === '') return setError('Elige qué pasa con sus conversaciones abiertas.');
    if (action === 'transfer' && to === '') return setError('Elige a quién pasarlas.');
    leave.mutate(
      { conversations: action === 'transfer' ? { action, to_user_id: to } : { action } },
      { onSuccess: onDone, onError: (e) => setError(friendlyError(e, 'No pudimos completar la acción.')) },
    );
  }

  return (
    <Modal title={removing ? `Quitar a ${member.name} del equipo` : `Desactivar a ${member.name}`} onClose={onClose} wide>
      <p className="text-[13.5px] text-muted">
        {removing
          ? 'Deja de pertenecer a tu empresa de forma definitiva: solo volvería con una invitación nueva. Su cuenta no se borra (puede pertenecer a otras empresas).'
          : 'No podrá entrar a tu empresa mientras esté desactivada. Puedes reactivarla cuando quieras.'}{' '}
        Se cerrarán todas sus sesiones y saldrá de los departamentos.
      </p>
      <fieldset className="grid gap-2">
        <legend className="text-[13.5px] font-semibold">
          {openConversations > 0 ? `Tiene ${openConversations} ${openConversations === 1 ? 'conversación abierta' : 'conversaciones abiertas'}. ¿Qué hacemos con ellas?` : '¿Qué hacemos con sus conversaciones abiertas, si las hubiera?'}
        </legend>
        <label className="flex items-start gap-2 rounded-xl border border-line p-3 text-[13.5px]">
          <input type="radio" name="leave-action" className="mt-1" checked={action === 'transfer'} onChange={() => setAction('transfer')} />
          <span><b>Transferirlas a otra persona</b><span className="block text-[12.5px] text-muted">Quedan pendientes para esa persona y los contactos y oportunidades abiertas se van con ellas.</span></span>
        </label>
        {action === 'transfer' ? (
          <Field label="Pasarlas a">
            {(p) => (
              <select {...p} className={selectCls} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Elige una persona</option>
                {targets.map((t) => <option key={t.user_id} value={t.user_id}>{t.name}</option>)}
              </select>
            )}
          </Field>
        ) : null}
        <label className="flex items-start gap-2 rounded-xl border border-line p-3 text-[13.5px]">
          <input type="radio" name="leave-action" className="mt-1" checked={action === 'unassign'} onChange={() => setAction('unassign')} />
          <span><b>Dejarlas sin asignación</b><span className="block text-[12.5px] text-muted">Quedan «sin asignar» y el reparto del departamento las toma si está encendido.</span></span>
        </label>
      </fieldset>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="danger" onClick={confirm} loading={leave.isPending}>{removing ? 'Quitar del equipo' : 'Desactivar'}</Button>
      </div>
    </Modal>
  );
}
