import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Company, Plan } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useAssignPlan } from './useCompanies';

/** Asignar o quitar el plan de una empresa, explicando el efecto antes de confirmar. */
export function AssignPlanDialog({ company, plans, onClose }: { company: Company; plans: Plan[]; onClose: () => void }) {
  const [choice, setChoice] = useState(company.plan?.id ?? '');
  const [error, setError] = useState<string>();
  const assign = useAssignPlan();
  const unchanged = choice === (company.plan?.id ?? '');
  const inTrial = company.state === 'trial' || company.state === 'trial_expired';

  const effect = choice
    ? inTrial
      ? 'La empresa dejará de estar en prueba: su acceso ya no depende de la prueba (si estaba vencida y en pausa, se reabre). El cobro es manual hasta definir la pasarela de pagos.'
      : 'Cambia el plan de la empresa.'
    : company.plan
      ? 'La empresa vuelve a depender de su prueba: si ya venció, su cuenta queda en pausa.'
      : '';

  function confirm() {
    setError(undefined);
    assign.mutate({ id: company.id, planId: choice || null }, { onSuccess: onClose, onError: (e) => setError(friendlyError(e)) });
  }

  return (
    <Modal title={`Plan de ${company.name}`} onClose={onClose}>
      <label htmlFor="plan-choice" className="text-[12.5px] font-semibold">Plan</label>
      <select id="plan-choice" value={choice} onChange={(e) => setChoice(e.target.value)} className="w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px]">
        <option value="">Sin plan</option>
        {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {plans.length === 0 ? <p className="text-[12.5px] text-muted">No hay planes disponibles: créalos en la pestaña «Planes».</p> : null}
      {effect ? <p className="text-[13px] text-muted">{effect}</p> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={unchanged} loading={assign.isPending} onClick={confirm}>{choice ? 'Asignar plan' : 'Quitar plan'}</Button>
      </div>
    </Modal>
  );
}
