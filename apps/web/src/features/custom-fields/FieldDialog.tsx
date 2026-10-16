import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { CustomField, CustomFieldType } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { FIELD_TYPE_LABEL, FIELD_TYPES, isOptionType, useCreateField, useUpdateField } from './useCustomFields';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal';
const MAX_OPTIONS = 50;
const MAX_OPTION_LENGTH = 100;

/** Una opción por línea → lista limpia (sin vacías); null si hay repetidas (sin distinguir mayúsculas), demasiadas o alguna muy larga. */
function parseOptions(text: string): { options: string[] } | { error: string } {
  const options = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (options.length === 0) return { error: 'Escribe al menos una opción (una por línea)' };
  if (options.length > MAX_OPTIONS) return { error: `Usa como máximo ${MAX_OPTIONS} opciones` };
  if (options.some((o) => o.length > MAX_OPTION_LENGTH)) return { error: `Cada opción puede tener hasta ${MAX_OPTION_LENGTH} caracteres` };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { error: 'Hay opciones repetidas' };
  return { options };
}

/**
 * Alta y edición de un campo personalizado (ADR-44). El tipo se elige al crear y NO se puede cambiar después; la variable se genera sola desde el nombre y
 * tampoco cambia. Las opciones se escriben una por línea. Renombrar una opción no actualiza los valores ya guardados.
 */
export function FieldDialog({ field, onClose }: { field?: CustomField; onClose: () => void }) {
  const editing = Boolean(field);
  const [name, setName] = useState(field?.name ?? '');
  const [type, setType] = useState<CustomFieldType>(field?.type ?? 'text');
  const [optionsText, setOptionsText] = useState((field?.options ?? []).join('\n'));
  const [showInForm, setShowInForm] = useState(field?.show_in_form ?? true);
  const [required, setRequired] = useState(field?.required ?? false);
  const [errors, setErrors] = useState<{ name?: string; options?: string }>({});
  const [formError, setFormError] = useState<string>();
  const create = useCreateField();
  const update = useUpdateField();
  const busy = create.isPending || update.isPending;

  function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    const next: { name?: string; options?: string } = {};
    const n = name.trim();
    if (n === '') next.name = 'Escribe el nombre del campo';
    else if (n.length > 80) next.name = 'Usa como máximo 80 caracteres';
    let options: string[] | undefined;
    if (isOptionType(type)) {
      const p = parseOptions(optionsText);
      if ('error' in p) next.options = p.error;
      else options = p.options;
    }
    setErrors(next);
    if (next.name || next.options) return;

    const req = showInForm && required;
    const handlers = { onSuccess: onClose, onError: (err: unknown) => setFormError(friendlyError(err, editing ? 'No pudimos guardar los cambios.' : 'No pudimos crear el campo.')) };
    if (field) update.mutate({ id: field.id, input: { name: n, ...(options ? { options } : {}), show_in_form: showInForm, required: req } }, handlers);
    else create.mutate({ name: n, type, ...(options ? { options } : {}), show_in_form: showInForm, required: req }, handlers);
  }

  return (
    <Modal title={editing ? 'Editar campo' : 'Nuevo campo'} onClose={onClose} wide>
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label={editing ? 'Editar campo' : 'Nuevo campo'}>
        <Field label="Nombre" error={errors.name} hint="Por ejemplo: Ciudad, Cédula o Nivel de experiencia.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" autoFocus />}
        </Field>

        {editing && field ? (
          <p className="grid gap-0.5 text-[12.5px]">
            <span><b>Tipo:</b> {FIELD_TYPE_LABEL[field.type]} <span className="text-muted">(no se puede cambiar; crea otro campo si necesitas otro tipo)</span></span>
            <span><b>Variable:</b> <code className="rounded bg-surface2 px-1.5 py-0.5">{`{{contact.${field.key}}}`}</code> <span className="text-muted">(no cambia aunque cambies el nombre)</span></span>
          </p>
        ) : (
          <Field label="Tipo" hint="No se podrá cambiar después.">
            {(p) => (
              <select {...p} value={type} onChange={(e) => setType(e.target.value as CustomFieldType)} className={selectCls}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>)}
              </select>
            )}
          </Field>
        )}

        {isOptionType(type) ? (
          <Field label="Opciones" error={errors.options} hint="Una por línea. Si cambias el nombre de una opción, los contactos que ya la tienen conservan el texto anterior.">
            {(p) => <textarea {...p} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} rows={5} className={`${selectCls} resize-y`} />}
          </Field>
        ) : null}

        <fieldset className="grid gap-2 text-[13.5px]">
          <legend className="sr-only">Cómo aparece en el formulario</legend>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={showInForm} onChange={(e) => { setShowInForm(e.target.checked); if (!e.target.checked) setRequired(false); }} />
            Mostrar en el formulario de contacto
          </label>
          <label className={`flex items-center gap-2 ${showInForm ? '' : 'text-muted'}`}>
            <input type="checkbox" checked={showInForm && required} disabled={!showInForm} onChange={(e) => setRequired(e.target.checked)} />
            Obligatorio
          </label>
        </fieldset>

        {formError ? <Alert>{formError}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={busy}>{editing ? 'Guardar' : 'Crear campo'}</Button>
        </div>
      </form>
    </Modal>
  );
}
