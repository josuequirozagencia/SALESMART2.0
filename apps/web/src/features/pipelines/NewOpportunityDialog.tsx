import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { OpportunityDetail, OwnerOption, Pipeline } from '../../lib/types';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { NO_CONTACT_FILTERS, useContacts } from '../contacts/useContacts';
import { parseAmount } from './amount';
import { useCreateOpportunity } from './useOpportunities';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal';

/**
 * Oportunidad nueva (M4.2, ADR-49): un contacto en un pipeline. Sin contacto fijo se busca uno; empieza en una etapa abierta (por defecto, la primera). Quien ve
 * todo (`viewAll`) puede asignarla a otra persona; el asesor la recibe asignada a sí mismo. Una por contacto y pipeline: si ya hay una abierta, el servidor lo dice.
 */
export function NewOpportunityDialog({
  pipelines,
  pipelineId,
  contact,
  viewAll,
  owners,
  onClose,
  onCreated,
}: {
  pipelines: Pipeline[];
  pipelineId?: string | undefined;
  contact?: { id: string; name: string } | undefined;
  viewAll: boolean;
  owners: OwnerOption[];
  onClose: () => void;
  onCreated: (o: OpportunityDetail) => void;
}) {
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(contact ?? null);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [pId, setPId] = useState(pipelineId && pipelines.some((p) => p.id === pipelineId) ? pipelineId : (pipelines[0]?.id ?? ''));
  const [stageId, setStageId] = useState('');
  const [amount, setAmount] = useState('');
  const [owner, setOwner] = useState('');
  const [errors, setErrors] = useState<{ contact?: string; amount?: string }>({});
  const [error, setError] = useState<string>();
  const create = useCreateOpportunity();

  const pipeline = pipelines.find((p) => p.id === pId);
  const stages = useMemo(() => (pipeline?.stages ?? []).filter((s) => s.kind === 'open' && !s.is_hidden), [pipeline]);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const search = useContacts({ ...NO_CONTACT_FILTERS, q }, undefined);
  const found = picked || q === '' ? [] : (search.data?.pages[0]?.items ?? []).slice(0, 6);

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const next: typeof errors = {};
    if (!picked) next.contact = 'Elige un contacto';
    const parsed = parseAmount(amount);
    if (parsed === null) next.amount = 'Escribe un monto válido (hasta 2 decimales)';
    setErrors(next);
    if (!picked || parsed === null) return;
    create.mutate(
      { contact_id: picked.id, ...(pId ? { pipeline_id: pId } : {}), ...(stageId ? { stage_id: stageId } : {}), ...(parsed !== '0.00' ? { amount: parsed } : {}), ...(viewAll && owner !== '' ? { owner_id: owner === 'none' ? null : owner } : {}) },
      { onSuccess: onCreated, onError: (err) => setError(friendlyError(err, 'No pudimos crear la oportunidad.')) },
    );
  }

  return (
    <Modal title="Nueva oportunidad" onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label="Nueva oportunidad">
        {contact ? (
          <p className="text-[13.5px]"><span className="font-semibold">Contacto:</span> {contact.name}</p>
        ) : picked ? (
          <p className="flex flex-wrap items-center gap-2 text-[13.5px]"><span><span className="font-semibold">Contacto:</span> {picked.name}</span><Button variant="link" onClick={() => { setPicked(null); setText(''); }}>Cambiar</Button></p>
        ) : (
          <div className="grid gap-1.5">
            <label className="grid gap-1 text-[12.5px] font-semibold">Contacto
              <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Busca por nombre, correo o teléfono" aria-invalid={errors.contact ? true : undefined} className="rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal aria-[invalid=true]:border-crit" autoFocus />
            </label>
            {errors.contact ? <span role="alert" className="text-[12px] font-medium text-crit">{errors.contact}</span> : null}
            {q !== '' && search.isPending ? <Spinner label="Buscando contactos" /> : null}
            {q !== '' && search.isSuccess && found.length === 0 ? <p className="text-[12.5px] text-muted">Ningún contacto coincide.</p> : null}
            <ul className="grid gap-1">
              {found.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setPicked({ id: c.id, name: c.name })} className="w-full rounded-lg border border-line px-3 py-1.5 text-left text-[13px] hover:bg-surface2" aria-label={`Elegir a ${c.name}`}>
                    <b>{c.name}</b> <span className="text-muted">{c.phones[0]?.e164 ?? c.email ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="grid gap-3 min-[520px]:grid-cols-2">
          <Field label="Pipeline">
            {(p) => (
              <select {...p} value={pId} onChange={(e) => { setPId(e.target.value); setStageId(''); }} className={selectCls}>
                {pipelines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Etapa">
            {(p) => (
              <select {...p} value={stageId} onChange={(e) => setStageId(e.target.value)} className={selectCls}>
                <option value="">{stages[0] ? `${stages[0].name} (la primera)` : 'La primera'}</option>
                {stages.slice(1).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </Field>
        </div>
        <Field label="Monto (USD)" error={errors.amount} hint="Opcional. Se puede cambiar después.">
          {(p) => <Input {...p} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoComplete="off" placeholder="0.00" />}
        </Field>
        {viewAll ? (
          <Field label="Responsable" hint="Por defecto, el responsable del contacto.">
            {(p) => (
              <select {...p} value={owner} onChange={(e) => setOwner(e.target.value)} className={selectCls}>
                <option value="">Como el contacto</option>
                <option value="none">Sin asignar</option>
                {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            )}
          </Field>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Crear oportunidad</Button>
        </div>
      </form>
    </Modal>
  );
}
