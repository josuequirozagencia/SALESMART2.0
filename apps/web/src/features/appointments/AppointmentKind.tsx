import { useState } from 'react';
import { Field, Input } from '../../ui/controls';

/** Tipos de cita que se ofrecen en la lista (la persona también puede escribir el suyo con «Otro…»). */
export const APPOINTMENT_KINDS = ['Cita', 'Visita al local', 'Llamada de cierre', 'Reunión virtual', 'Entrega de propuesta', 'Consulta', 'Seguimiento'] as const;
const OTHER = '__other__';
const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal text-fg';

/**
 * Tipo de cita: se escoge de una lista o se escribe libre («Otro…»). Un valor que no está en la lista (por ejemplo, el de una cita ya creada) abre directamente el campo de texto.
 * El valor que sube es siempre el texto final (el servidor recibe un texto libre de hasta 60 caracteres, como siempre).
 */
export function KindField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string | undefined }) {
  const known = (APPOINTMENT_KINDS as readonly string[]).includes(value);
  const [other, setOther] = useState(!known && value !== '');
  const selected = other ? OTHER : value;
  return (
    <div className="grid gap-2">
      <Field label="Tipo de cita" error={other ? undefined : error}>
        {(f) => (
          <select
            {...f}
            className={selectCls}
            value={selected}
            onChange={(e) => {
              if (e.target.value === OTHER) {
                setOther(true);
                onChange('');
              } else {
                setOther(false);
                onChange(e.target.value);
              }
            }}
          >
            {APPOINTMENT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            <option value={OTHER}>Otro (escribir)…</option>
          </select>
        )}
      </Field>
      {other ? (
        <Field label="Escribe el tipo de cita" error={error}>
          {(f) => <Input {...f} value={value} maxLength={60} placeholder="Por ejemplo: Evaluación inicial" onChange={(e) => onChange(e.target.value)} />}
        </Field>
      ) : null}
    </div>
  );
}
