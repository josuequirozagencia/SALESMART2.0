import { useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { COUNTRIES, normalizePhone } from '../../lib/phone';
import type { Consent, Contact, CustomValue, OwnerOption } from '../../lib/types';
import { isEmail, normalizeEmail } from '../../lib/validation';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { FieldInput } from '../custom-fields/FieldInput';
import { AttributionSection, TagBadges } from './AttributionSection';
import { parseRaw, toRaw, type RawValue } from '../custom-fields/fieldValues';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { useCreateContact, useDeleteContact, useUpdateContact, type ContactInput } from './useContacts';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal';
const CONSENT_LABEL: Record<Consent, string> = { unknown: 'Sin definir', granted: 'Con consentimiento', revoked: 'Sin consentimiento (lo retiró)' };
const MAX_PHONES = 5;

interface Errors {
  name?: string;
  email?: string;
  owner?: string;
  phones: Record<number, string>;
  /** Por variable del campo personalizado. */
  custom: Record<string, string>;
}

/**
 * Alta y edición de un contacto (ADR-32 #3, ADR-43). Los teléfonos se escriben con «+» (internacional) o sin él: en ese caso se les antepone el prefijo
 * elegido. El primero es el principal. `canAssign` (quien puede ver todos los contactos) habilita elegir el responsable; sin él, el servidor asigna el
 * contacto a quien lo crea. `canDelete` y `readOnly` solo muestran u ocultan botones: el servidor decide qué se permite.
 */
export function ContactDialog({ contact, owners, canAssign, canDelete, readOnly, onClose }: { contact?: Contact; owners: OwnerOption[]; canAssign: boolean; canDelete: boolean; readOnly: boolean; onClose: () => void }) {
  const editing = Boolean(contact);
  const [name, setName] = useState(contact?.name ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [phones, setPhones] = useState<string[]>(contact && contact.phones.length > 0 ? contact.phones.map((p) => p.e164) : ['']);
  const [prefix, setPrefix] = useState<string>(COUNTRIES[0].code);
  const [ownerId, setOwnerId] = useState(contact?.owner?.id ?? '');
  const [consent, setConsent] = useState<Consent>(contact?.consent ?? 'unknown');
  const [errors, setErrors] = useState<Errors>({ phones: {}, custom: {} });
  // Campos personalizados que se muestran en el formulario; `edits` guarda solo lo que la persona tocó (lo demás sale del contacto)
  const defs = (useCustomFields().data?.items ?? []).filter((f) => f.show_in_form && f.archived_at === null);
  const [edits, setEdits] = useState<Record<string, RawValue>>({});
  const [formError, setFormError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const create = useCreateContact();
  const update = useUpdateContact();
  const remove = useDeleteContact();
  const busy = create.isPending || update.isPending;

  const rawOf = (key: string): RawValue => {
    const def = defs.find((d) => d.key === key)!;
    return edits[key] ?? toRaw(def, contact?.custom_fields[key]);
  };
  const setPhone = (i: number, v: string) => setPhones((p) => p.map((x, j) => (j === i ? v : x)));

  function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    const next: Errors = { phones: {}, custom: {} };
    const n = name.trim();
    if (n.length < 1) next.name = 'Escribe el nombre';
    else if (n.length > 200) next.name = 'Usa como máximo 200 caracteres';
    const em = normalizeEmail(email);
    if (em !== '' && !isEmail(em)) next.email = 'Escribe un correo válido';
    const normalized: string[] = [];
    phones.forEach((p, i) => {
      if (p.trim() === '') return;
      const e164 = normalizePhone(p, prefix);
      if (!e164) next.phones[i] = 'Número no válido: usa de 8 a 15 dígitos (con el prefijo del país o «+»)';
      else if (normalized.includes(e164)) next.phones[i] = 'Este número está repetido';
      else normalized.push(e164);
    });
    // Campos personalizados: al crear se envían los que tienen valor; al editar, solo los que la persona cambió (un obligatorio no se puede vaciar)
    const custom: Record<string, CustomValue | null> = {};
    for (const def of defs) {
      const raw = rawOf(def.key);
      const p = parseRaw(def, raw, prefix);
      if (!p.ok) {
        next.custom[def.key] = p.error;
        continue;
      }
      if (editing && JSON.stringify(raw) === JSON.stringify(toRaw(def, contact?.custom_fields[def.key]))) continue;
      if (p.value === null) {
        if (def.required) next.custom[def.key] = 'Este campo es obligatorio';
        else if (editing) custom[def.key] = null;
        continue;
      }
      custom[def.key] = p.value;
    }
    setErrors(next);
    if (next.name || next.email || Object.keys(next.phones).length > 0 || Object.keys(next.custom).length > 0) return;

    const base: ContactInput = { name: n, email: em === '' ? null : em, phones: normalized, consent };
    const withOwner: ContactInput = canAssign ? { ...base, owner_id: ownerId === '' ? null : ownerId } : base;
    const input: ContactInput = Object.keys(custom).length > 0 ? { ...withOwner, custom_fields: custom } : withOwner;
    const handlers = {
      onSuccess: onClose,
      onError: (err: unknown) => {
        if (err instanceof ApiError && (err.code === 'PHONE_TAKEN' || err.code === 'VALIDATION_ERROR')) {
          const byIndex: Record<number, string> = {};
          let owner: string | undefined;
          const customErrors: Record<string, string> = {};
          for (const d of err.details) {
            const cf = /^custom_fields\.(.+)$/.exec(d.path);
            if (cf) customErrors[cf[1]!] = d.message;
            const m = /^phones\.(\d+)$/.exec(d.path);
            if (m) byIndex[Number(m[1])] = d.code === 'duplicate' ? 'Ya existe un contacto con este teléfono' : 'Número no válido';
            if (d.path === 'owner_id') owner = 'Esa persona no puede recibir contactos';
          }
          // Los índices del servidor cuentan solo los números escritos: se llevan de vuelta a su fila
          const rows = phones.map((p, i) => [p, i] as const).filter(([p]) => p.trim() !== '').map(([, i]) => i);
          const mapped: Record<number, string> = {};
          for (const [k, v] of Object.entries(byIndex)) mapped[rows[Number(k)] ?? Number(k)] = v;
          setErrors((cur) => ({ ...cur, phones: mapped, custom: customErrors, ...(owner ? { owner } : {}) }));
        }
        setFormError(friendlyError(err, editing ? 'No pudimos guardar los cambios.' : 'No pudimos crear el contacto.'));
      },
    };
    if (contact) update.mutate({ id: contact.id, input }, handlers);
    else create.mutate(input, handlers);
  }

  function doDelete() {
    if (!contact) return;
    setFormError(undefined);
    remove.mutate(contact.id, { onSuccess: onClose, onError: (err) => { setConfirmDelete(false); setFormError(friendlyError(err, 'No pudimos borrar el contacto.')); } });
  }

  const disabled = readOnly;
  return (
    <Modal title={editing ? 'Contacto' : 'Nuevo contacto'} onClose={onClose} wide>
      {readOnly ? <Alert kind="info">Estás en modo solo lectura: puedes ver este contacto, no cambiarlo.</Alert> : null}
      {contact ? <TagBadges tags={contact.tags} /> : null}
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label={editing ? 'Contacto' : 'Nuevo contacto'}>
        <Field label="Nombre" error={errors.name}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoComplete="off" disabled={disabled} autoFocus={!editing} />}
        </Field>
        <Field label="Correo" error={errors.email} hint="Opcional.">
          {(p) => <Input {...p} type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" disabled={disabled} />}
        </Field>

        <fieldset className="grid gap-2" disabled={disabled}>
          <legend className="text-[12.5px] font-semibold">Teléfonos</legend>
          <label className="grid gap-1 text-[12px] font-semibold min-[520px]:max-w-[260px]">País de los números sin «+»
            <select value={prefix} onChange={(e) => setPrefix(e.target.value)} className={selectCls}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
          {phones.map((p, i) => (
            <div key={i} className="grid gap-1">
              <div className="flex items-center gap-2">
                <Input value={p} onChange={(e) => setPhone(i, e.target.value)} inputMode="tel" autoComplete="off" aria-label={`Teléfono ${i + 1}${i === 0 ? ' (principal)' : ''}`} aria-invalid={errors.phones[i] ? true : undefined} placeholder={i === 0 ? '098 421 7730 o +593984217730' : ''} />
                {phones.length > 1 && !disabled ? <Button className="!px-3 !py-2 !text-[12.5px]" aria-label={`Quitar el teléfono ${i + 1}`} onClick={() => setPhones((x) => x.filter((_, j) => j !== i))}>Quitar</Button> : null}
              </div>
              {errors.phones[i] ? <span role="alert" className="text-[12px] font-medium text-crit">{errors.phones[i]}</span> : null}
            </div>
          ))}
          {phones.length < MAX_PHONES && !disabled ? <div><Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setPhones((x) => [...x, ''])}>Agregar otro teléfono</Button></div> : null}
          <span className="text-[12px] text-muted">El primero es el principal. Cada número es único en tu empresa.</span>
        </fieldset>

        {canAssign ? (
          <Field label="Responsable" error={errors.owner} hint="Quién atiende este contacto. Los asesores ven solo los que tienen asignados.">
            {(p) => (
              <select {...p} value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={selectCls} disabled={disabled}>
                <option value="">Sin asignar</option>
                {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                {contact?.owner && !owners.some((o) => o.id === contact.owner!.id) ? <option value={contact.owner.id}>{contact.owner.name} (ya no está en el equipo)</option> : null}
              </select>
            )}
          </Field>
        ) : null}

        <Field label="Consentimiento para escribirle" hint="Los contactos sin consentimiento no reciben mensajes automáticos.">
          {(p) => (
            <select {...p} value={consent} onChange={(e) => setConsent(e.target.value as Consent)} className={selectCls} disabled={disabled}>
              {(Object.keys(CONSENT_LABEL) as Consent[]).map((c) => <option key={c} value={c}>{CONSENT_LABEL[c]}</option>)}
            </select>
          )}
        </Field>

        {defs.length > 0 ? (
          <fieldset className="grid gap-3" disabled={disabled}>
            <legend className="text-[12.5px] font-semibold">Campos adicionales</legend>
            <div className="grid gap-3 min-[520px]:grid-cols-2">
              {defs.map((def) => (
                <div key={def.id} className={def.type === 'long_text' || def.type === 'multiselect' ? 'min-[520px]:col-span-2' : ''}>
                  <FieldInput def={def} value={rawOf(def.key)} onChange={(v) => setEdits((cur) => ({ ...cur, [def.key]: v }))} error={errors.custom[def.key]} disabled={disabled} />
                </div>
              ))}
            </div>
          </fieldset>
        ) : null}

        {contact ? <AttributionSection contact={contact} /> : null}

        {formError ? <Alert>{formError}</Alert> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {editing && canDelete && !readOnly ? (
            confirmDelete ? (
              <span className="flex items-center gap-2 text-[13px]">¿Borrar este contacto?
                <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={remove.isPending} onClick={doDelete}>Sí, borrar</Button>
                <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirmDelete(false)}>No</Button>
              </span>
            ) : (
              <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirmDelete(true)}>Borrar contacto</Button>
            )
          ) : <span />}
          <span className="flex gap-2">
            <Button type="button" onClick={onClose}>{readOnly ? 'Cerrar' : 'Cancelar'}</Button>
            {!readOnly ? <Button type="submit" variant="primary" loading={busy}>{editing ? 'Guardar' : 'Crear contacto'}</Button> : null}
          </span>
        </div>
      </form>
    </Modal>
  );
}
