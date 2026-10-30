import { useState } from 'react';
import type { Consent, ContactTag, CustomField, CustomFieldType } from '../../lib/types';
import { Button } from '../../ui/controls';
import { FIELD_TYPE_LABEL } from '../custom-fields/useCustomFields';
import { useCompany } from '../crm/useCrm';
import { CompanyFilter } from './CompanyFilter';
import type { ContactFilters } from './useContacts';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] font-normal';
const CONSENT_LABEL: Record<Consent, string> = { granted: 'Con consentimiento', revoked: 'Sin consentimiento (lo retiró)', unknown: 'Consentimiento sin definir' };

type Op = 'eq' | 'contains' | 'gte' | 'lte' | 'is_set' | 'is_empty';
const OP_LABEL: Record<Op, string> = { eq: 'es igual a', contains: 'contiene', gte: 'es mayor o igual a', lte: 'es menor o igual a', is_set: 'tiene valor', is_empty: 'está vacío' };
const TEXTLIKE: ReadonlySet<CustomFieldType> = new Set(['text', 'long_text', 'email', 'phone', 'url']);
const NUMBERISH: ReadonlySet<CustomFieldType> = new Set(['number', 'currency', 'percent', 'date']);

/** Operadores que acepta cada tipo (los mismos que valida el servidor, ADR-46 #4). */
export const opsFor = (t: CustomFieldType): Op[] =>
  TEXTLIKE.has(t) ? ['eq', 'contains', 'is_set', 'is_empty'] : t === 'select' ? ['eq', 'is_set', 'is_empty'] : t === 'multiselect' ? ['contains', 'is_set', 'is_empty'] : NUMBERISH.has(t) ? ['eq', 'gte', 'lte', 'is_set', 'is_empty'] : t === 'datetime' ? ['gte', 'lte', 'is_set', 'is_empty'] : ['eq', 'is_set', 'is_empty'];

/** Texto legible de un filtro de campo guardado como `variable:operador[:valor]`. */
export function describeCf(raw: string, fields: readonly CustomField[]): string {
  const first = raw.indexOf(':');
  const key = raw.slice(0, first);
  const rest = raw.slice(first + 1);
  const second = rest.indexOf(':');
  const op = (second < 0 ? rest : rest.slice(0, second)) as Op;
  const value = second < 0 ? '' : rest.slice(second + 1);
  const name = fields.find((f) => f.key === key)?.name ?? key;
  const shown = value === 'true' ? 'Sí' : value === 'false' ? 'No' : value;
  return `${name} ${OP_LABEL[op] ?? op}${shown ? ` ${shown}` : ''}`;
}

/** Etiqueta del filtro por empresa: usa el nombre guardado o, si solo hay identificador (lista guardada), lo pide al servidor. */
function CompanyChip({ filters, onRemove }: { filters: ContactFilters; onRemove: () => void }) {
  const name = useCompany(filters.companyName ? '' : filters.company).data?.name;
  return <Chip text={`Empresa: ${filters.companyName || name || '…'}`} onRemove={onRemove} />;
}

function Chip({ text, onRemove }: { text: string; onRemove: () => void }) {
  return (
    <li className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface2 py-0.5 pl-2.5 pr-1 text-[12.5px]">
      {text}
      <button type="button" aria-label={`Quitar el filtro ${text}`} onClick={onRemove} className="grid size-5 place-items-center rounded-full text-muted hover:bg-line hover:text-fg">×</button>
    </li>
  );
}

/** Formulario para sumar un filtro por campo personalizado. */
function CfForm({ fields, onAdd }: { fields: readonly CustomField[]; onAdd: (raw: string) => void }) {
  const [key, setKey] = useState(fields[0]?.key ?? '');
  const field = fields.find((f) => f.key === key);
  const ops = field ? opsFor(field.type) : [];
  const [op, setOp] = useState<Op>(ops[0] ?? 'eq');
  const [value, setValue] = useState('');
  const needsValue = op !== 'is_set' && op !== 'is_empty';
  const valid = field !== undefined && (!needsValue || value.trim() !== '');

  function pickField(k: string) {
    setKey(k);
    const f = fields.find((x) => x.key === k);
    setOp(f ? (opsFor(f.type)[0] ?? 'eq') : 'eq');
    setValue('');
  }
  const input = (() => {
    if (!needsValue || !field) return null;
    const common = { 'aria-label': 'Valor del filtro', value, onChange: (e: { target: { value: string } }) => setValue(e.target.value), className: selectCls };
    if (field.type === 'select' || field.type === 'multiselect') return <select {...common}><option value="">Elige…</option>{(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>;
    if (field.type === 'boolean') return <select {...common}><option value="">Elige…</option><option value="true">Sí</option><option value="false">No</option></select>;
    if (field.type === 'date') return <input {...common} type="date" />;
    if (field.type === 'datetime') return <input {...common} type="datetime-local" />;
    return <input {...common} type="text" inputMode={NUMBERISH.has(field.type) ? 'decimal' : 'text'} placeholder="Valor" />;
  })();

  return (
    <form
      aria-label="Filtrar por campo"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || !field) return;
        const raw = field.type === 'datetime' ? new Date(value).toISOString() : NUMBERISH.has(field.type) ? value.trim().replace(',', '.') : value.trim();
        onAdd(needsValue ? `${field.key}:${op}:${raw}` : `${field.key}:${op}`);
        setValue('');
      }}
    >
      <label className="grid gap-1 text-[12px] font-semibold">Campo
        <select aria-label="Campo" value={key} onChange={(e) => pickField(e.target.value)} className={selectCls}>{fields.map((f) => <option key={f.id} value={f.key}>{f.name} ({FIELD_TYPE_LABEL[f.type]})</option>)}</select>
      </label>
      <label className="grid gap-1 text-[12px] font-semibold">Condición
        <select aria-label="Condición" value={op} onChange={(e) => { setOp(e.target.value as Op); setValue(''); }} className={selectCls}>{ops.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}</select>
      </label>
      {input}
      <Button type="submit" className="!px-3 !py-2 !text-[13px]" disabled={!valid}>Agregar filtro</Button>
    </form>
  );
}

/**
 * Filtros del listado (ADR-46 #4): consentimiento, etiquetas (todas las elegidas) y campos personalizados; los activos se ven como etiquetas que se quitan
 * con la ×. La búsqueda, el responsable y el orden viven en la cabecera de la página.
 */
export function FilterBar({
  filters,
  onChange,
  tags,
  fields,
}: {
  filters: ContactFilters;
  onChange: (f: ContactFilters) => void;
  tags: readonly ContactTag[];
  fields: readonly CustomField[];
}) {
  const [adding, setAdding] = useState(false);
  const tagName = (id: string) => tags.find((t) => t.id === id)?.name ?? 'Etiqueta';
  const free = tags.filter((t) => !filters.tags.includes(t.id));
  const chips: Array<{ key: string; text: string; remove: () => void }> = [
    ...(filters.consent ? [{ key: 'consent', text: CONSENT_LABEL[filters.consent], remove: () => onChange({ ...filters, consent: '' }) }] : []),
    ...filters.tags.map((id) => ({ key: `t:${id}`, text: `Etiqueta: ${tagName(id)}`, remove: () => onChange({ ...filters, tags: filters.tags.filter((x) => x !== id) }) })),
    ...filters.cf.map((raw, i) => ({ key: `c:${i}`, text: describeCf(raw, fields), remove: () => onChange({ ...filters, cf: filters.cf.filter((_, j) => j !== i) }) })),
  ];
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-[12px] font-semibold">Consentimiento
          <select aria-label="Consentimiento" value={filters.consent} onChange={(e) => onChange({ ...filters, consent: e.target.value as ContactFilters['consent'] })} className={selectCls}>
            <option value="">Todos</option>
            {(Object.keys(CONSENT_LABEL) as Consent[]).map((c) => <option key={c} value={c}>{CONSENT_LABEL[c]}</option>)}
          </select>
        </label>
        <CompanyFilter onPick={(c) => onChange({ ...filters, company: c.id, companyName: c.name })} />
        {free.length > 0 ? (
          <label className="grid gap-1 text-[12px] font-semibold">Etiqueta
            <select aria-label="Etiqueta" value="" onChange={(e) => e.target.value && onChange({ ...filters, tags: [...filters.tags, e.target.value] })} className={selectCls}>
              <option value="">Agregar etiqueta…</option>
              {free.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        ) : null}
        {fields.length > 0 ? <Button className="!px-3 !py-2 !text-[13px]" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>Filtrar por campo</Button> : null}
      </div>
      {adding && fields.length > 0 ? <CfForm key={fields.map((f) => f.id).join()} fields={fields} onAdd={(raw) => onChange({ ...filters, cf: [...filters.cf, raw] })} /> : null}
      {chips.length > 0 || filters.company ? (
        <ul aria-label="Filtros activos" className="flex flex-wrap gap-1.5">
          {filters.company ? <CompanyChip filters={filters} onRemove={() => onChange({ ...filters, company: '', companyName: '' })} /> : null}
          {chips.map((c) => <Chip key={c.key} text={c.text} onRemove={c.remove} />)}
        </ul>
      ) : null}
    </div>
  );
}
