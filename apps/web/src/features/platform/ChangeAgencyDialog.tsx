import { useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Agency, Company } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useAssignAgency } from './useAgencies';

/**
 * Cambiar quién administra a un cliente (ADR-22): una agencia o administración directa. Solo el Súper Admin. Explica el efecto antes de
 * confirmar: la agencia anterior pierde el acceso al instante y la nueva lo recibe; plan, facturación y datos no cambian.
 */
export function ChangeAgencyDialog({ company, agencies, onClose }: { company: Company; agencies: Agency[]; onClose: () => void }) {
  const [choice, setChoice] = useState(company.agency?.id ?? '');
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState<string>();
  const assign = useAssignAgency();
  const unchanged = choice === (company.agency?.id ?? '');
  // Una agencia suspendida no es destino válido (la API responde 409); la actual se muestra aunque lo esté, para verla seleccionada.
  // Una agencia con la invitación pendiente sí: su cartera se prepara y recibe acceso cuando su dueño acepte.
  const options = agencies.filter((a) => a.state !== 'suspended' || a.id === company.agency?.id);

  const effect = unchanged
    ? ''
    : choice
      ? company.agency
        ? `${company.agency.name} pierde el acceso al instante y la agencia elegida lo recibe.`
        : 'La agencia elegida recibe acceso a esta empresa.'
      : `${company.agency?.name ?? 'La agencia'} pierde el acceso al instante: la empresa pasa a administración directa.`;

  function confirm() {
    setError(undefined);
    assign.mutate({ id: company.id, agencyId: choice || null, reason, notifyClient: notify }, { onSuccess: onClose, onError: (e) => setError(friendlyError(e, 'No pudimos cambiar la administración.')) });
  }

  return (
    <Modal title={`Administración de ${company.name}`} onClose={onClose}>
      <Field label="Administra">
        {(p) => (
          <select {...p} value={choice} onChange={(e) => setChoice(e.target.value)} className="w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal">
            <option value="">Administración directa (sin agencia)</option>
            {options.map((a) => <option key={a.id} value={a.id}>{a.name}{a.state === 'suspended' ? ' (suspendida)' : ''}</option>)}
          </select>
        )}
      </Field>
      {agencies.length === 0 ? <p className="text-[12.5px] text-muted">Todavía no hay agencias: créalas en la pestaña «Agencias».</p> : null}
      {effect ? <p className="text-[13px] text-muted">{effect} Su plan, su facturación y sus datos no cambian.</p> : null}
      <Field label="Motivo (opcional)" hint="Queda en el historial de la cartera.">
        {(p) => <Input {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-[3px]" />
        <span>Avisar por correo al administrador de la empresa</span>
      </label>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" disabled={unchanged} loading={assign.isPending} onClick={confirm}>Guardar cambio</Button>
      </div>
    </Modal>
  );
}
