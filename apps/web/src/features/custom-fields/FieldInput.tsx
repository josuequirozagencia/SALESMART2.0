import type { CustomField } from '../../lib/types';
import { Field, Input } from '../../ui/controls';
import type { RawValue } from './fieldValues';

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal';

/** Etiqueta del campo con el aviso de obligatorio (el asterisco no entra en el nombre accesible). */
const Label = ({ def }: { def: CustomField }) => <>{def.name}{def.required ? <span aria-hidden="true" className="ml-0.5 text-crit">*</span> : null}</>;

/**
 * Control de un campo personalizado según su tipo. El valor es siempre texto (lista para la selección múltiple); `fieldValues.ts` lo convierte.
 * Una opción guardada que ya no está en la lista se conserva a la vista como «(opción anterior)» para no perder el dato al editar.
 */
export function FieldInput({ def, value, onChange, error, disabled }: { def: CustomField; value: RawValue; onChange: (v: RawValue) => void; error?: string | undefined; disabled?: boolean }) {
  const text = Array.isArray(value) ? '' : value;
  const common = { disabled: disabled === true, 'aria-required': def.required || undefined };

  if (def.type === 'multiselect') {
    const picked = Array.isArray(value) ? value : [];
    const options = [...(def.options ?? []), ...picked.filter((p) => !(def.options ?? []).includes(p))];
    return (
      <fieldset className="grid gap-1.5" disabled={disabled}>
        <legend className="text-[12.5px] font-semibold"><Label def={def} /></legend>
        <div className="flex flex-wrap gap-2">
          {options.map((o) => {
            const on = picked.includes(o);
            return (
              <label key={o} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[13px] has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input type="checkbox" checked={on} onChange={() => onChange(on ? picked.filter((p) => p !== o) : [...picked, o])} />
                {o}{def.options?.includes(o) ? '' : ' (opción anterior)'}
              </label>
            );
          })}
        </div>
        {error ? <span role="alert" className="text-[12px] font-medium text-crit">{error}</span> : null}
      </fieldset>
    );
  }

  return (
    <Field label={def.name} error={error} required={def.required}>
      {(p) => {
        switch (def.type) {
          case 'long_text':
            return <textarea {...p} {...common} value={text} onChange={(e) => onChange(e.target.value)} rows={3} maxLength={5000} className={`${selectCls} resize-y`} />;
          case 'boolean':
            return (
              <select {...p} {...common} value={text} onChange={(e) => onChange(e.target.value)} className={selectCls}>
                <option value="">—</option><option value="true">Sí</option><option value="false">No</option>
              </select>
            );
          case 'select': {
            const options = def.options ?? [];
            const stale = text !== '' && !options.includes(text);
            return (
              <select {...p} {...common} value={text} onChange={(e) => onChange(e.target.value)} className={selectCls}>
                <option value="">—</option>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
                {stale ? <option value={text}>{text} (opción anterior)</option> : null}
              </select>
            );
          }
          case 'date':
            return <Input {...p} {...common} type="date" value={text} onChange={(e) => onChange(e.target.value)} />;
          case 'datetime':
            return <Input {...p} {...common} type="datetime-local" value={text} onChange={(e) => onChange(e.target.value)} />;
          case 'number':
          case 'currency':
          case 'percent':
            return <Input {...p} {...common} type="text" inputMode="decimal" value={text} onChange={(e) => onChange(e.target.value)} autoComplete="off" />;
          case 'email':
            return <Input {...p} {...common} type="email" inputMode="email" value={text} onChange={(e) => onChange(e.target.value)} autoComplete="off" />;
          case 'phone':
            return <Input {...p} {...common} type="tel" inputMode="tel" value={text} onChange={(e) => onChange(e.target.value)} autoComplete="off" />;
          case 'url':
            return <Input {...p} {...common} type="url" inputMode="url" value={text} onChange={(e) => onChange(e.target.value)} autoComplete="off" placeholder="https://" />;
          default:
            return <Input {...p} {...common} type="text" value={text} onChange={(e) => onChange(e.target.value)} maxLength={500} autoComplete="off" />;
        }
      }}
    </Field>
  );
}
