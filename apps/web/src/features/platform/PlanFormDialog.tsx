import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { Plan } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { usePlanMutations, type PlanInput } from './usePlans';

const LIMIT_MAX = 100_000;

/** «» = ilimitado (null). Devuelve el número, null o `undefined` si es inválido. */
function parseLimit(v: string): number | null | undefined {
  const t = v.trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= LIMIT_MAX ? n : undefined;
}

type Errors = { name?: string; max_users?: string; max_connections?: string; max_queues?: string };
const LIMIT_ERR = `Un número entre 1 y ${LIMIT_MAX.toLocaleString('es-EC')}, o déjalo vacío para ilimitado`;

/** Crear o editar un plan: nombre, descripción, límites (vacío = ilimitado) y los módulos que enciende. Sin precios todavía. */
export function PlanFormDialog({ plan, catalog, onClose }: { plan: Plan | null; catalog: Array<{ key: string; label: string }>; onClose: () => void }) {
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [limits, setLimits] = useState({ max_users: plan?.max_users?.toString() ?? '', max_connections: plan?.max_connections?.toString() ?? '', max_queues: plan?.max_queues?.toString() ?? '' });
  const [features, setFeatures] = useState<Record<string, boolean>>(() => Object.fromEntries(catalog.map((f) => [f.key, plan?.features[f.key] ?? false])));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const { create, update } = usePlanMutations();
  const busy = create.isPending || update.isPending;

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    const n = name.trim();
    if (n.length < 2) next.name = 'Escribe un nombre de al menos 2 caracteres';
    else if (n.length > 60) next.name = 'Usa como máximo 60 caracteres';
    const lim = { max_users: parseLimit(limits.max_users), max_connections: parseLimit(limits.max_connections), max_queues: parseLimit(limits.max_queues) };
    for (const k of ['max_users', 'max_connections', 'max_queues'] as const) if (lim[k] === undefined) next[k] = LIMIT_ERR;
    setErrors(next);
    setFormError(undefined);
    if (Object.keys(next).length > 0) return;
    const body: PlanInput = { name: n, description: description.trim() === '' ? null : description.trim(), max_users: lim.max_users ?? null, max_connections: lim.max_connections ?? null, max_queues: lim.max_queues ?? null, features };
    const onError = (err: unknown) => {
      if (err instanceof ApiError && err.code === 'PLAN_NAME_TAKEN') setErrors({ name: err.message });
      else setFormError(friendlyError(err));
    };
    if (plan) update.mutate({ id: plan.id, patch: body }, { onSuccess: onClose, onError });
    else create.mutate(body, { onSuccess: onClose, onError });
  }

  const limitField = (key: 'max_users' | 'max_connections' | 'max_queues', label: string) => (
    <Field label={label} error={errors[key]}>
      {(p) => <Input {...p} inputMode="numeric" placeholder="Ilimitado" value={limits[key]} onChange={(e) => setLimits((l) => ({ ...l, [key]: e.target.value }))} />}
    </Field>
  );

  return (
    <Modal title={plan ? `Editar plan «${plan.name}»` : 'Nuevo plan'} onClose={onClose} wide>
      <form onSubmit={submit} noValidate className="grid gap-3.5">
        <Field label="Nombre" error={errors.name}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Pro" autoFocus />}
        </Field>
        <Field label="Descripción (opcional)">
          {(p) => <Input {...p} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="Para equipos que atienden por varios canales" />}
        </Field>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[12.5px] font-semibold">Límites</legend>
          <div className="grid gap-3 min-[520px]:grid-cols-3">
            {limitField('max_users', 'Usuarios')}
            {limitField('max_connections', 'Conexiones')}
            {limitField('max_queues', 'Departamentos')}
          </div>
          <p className="text-[12px] text-muted">Vacío = ilimitado. Los módulos aplican los límites cuando existan.</p>
        </fieldset>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-[12.5px] font-semibold">Módulos que enciende</legend>
          <div className="grid gap-1.5 min-[520px]:grid-cols-2">
            {catalog.map((f) => (
              <label key={f.key} className="flex items-center gap-2 rounded-[10px] border border-line px-3 py-2 text-[13px]">
                <input type="checkbox" checked={features[f.key] ?? false} onChange={(e) => setFeatures((s) => ({ ...s, [f.key]: e.target.checked }))} className="accent-[var(--accent)]" />
                {f.label}
              </label>
            ))}
          </div>
        </fieldset>
        {formError ? <Alert>{formError}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={busy}>{plan ? 'Guardar cambios' : 'Crear plan'}</Button>
        </div>
      </form>
    </Modal>
  );
}
