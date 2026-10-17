import { shortDate } from '../../lib/format';
import { formatPhone } from '../../lib/phone';
import type { Consent, Contact, CustomField } from '../../lib/types';
import { Pill, type PillKind } from '../../ui/Pill';
import { TagBadges } from './AttributionSection';
import { customText, type ColumnDef } from './columns';

const CONSENT: Record<Consent, [PillKind, string]> = { granted: ['ok', 'Con consentimiento'], revoked: ['crit', 'Sin consentimiento'], unknown: ['muted', 'Sin definir'] };

function Cell({ c, col, field, onOpen }: { c: Contact; col: string; field: CustomField | undefined; onOpen: (c: Contact) => void }) {
  switch (col) {
    case 'name':
      return <button type="button" aria-label={`Abrir el contacto ${c.name}`} onClick={() => onOpen(c)} className="max-w-[260px] truncate text-left font-semibold text-accent hover:underline">{c.name}</button>;
    case 'phone': {
      const first = c.phones[0];
      return first ? <span>{formatPhone(first.e164)}{c.phones.length > 1 ? <span className="text-muted"> · +{c.phones.length - 1} más</span> : null}</span> : <span className="text-muted">—</span>;
    }
    case 'email':
      return c.email ? <span className="block max-w-[220px] truncate">{c.email}</span> : <span className="text-muted">—</span>;
    case 'owner':
      return c.owner ? <span>{c.owner.name}</span> : <span className="text-muted">Sin asignar</span>;
    case 'source':
      return <span>{c.source}</span>;
    case 'consent': {
      const [kind, label] = CONSENT[c.consent];
      return <Pill kind={kind}>{label}</Pill>;
    }
    case 'tags':
      return c.tags.length > 0 ? <TagBadges tags={c.tags} /> : <span className="text-muted">—</span>;
    case 'campaign':
      return c.attribution?.last_touch?.campaign ? <span className="block max-w-[200px] truncate">{c.attribution.last_touch.campaign}</span> : <span className="text-muted">—</span>;
    case 'created_at':
      return <span>{shortDate(c.created_at)}</span>;
    case 'updated_at':
      return <span>{shortDate(c.updated_at)}</span>;
    default: {
      const text = customText(field, c.custom_fields[col.slice(3)]);
      return text ? <span className="block max-w-[200px] truncate" title={text}>{text}</span> : <span className="text-muted">—</span>;
    }
  }
}

/**
 * Tabla de contactos con columnas configurables y selección (M3.4, ADR-46). El nombre abre el contacto. La tabla se desplaza dentro de su recuadro: la página
 * nunca se ensancha. Las casillas solo aparecen si la persona puede crear listas.
 */
export function ContactsTable({
  items,
  columns,
  catalog,
  fields,
  selected,
  selectable,
  onToggle,
  onToggleAll,
  onOpen,
}: {
  items: readonly Contact[];
  columns: readonly string[];
  catalog: readonly ColumnDef[];
  fields: readonly CustomField[];
  selected: ReadonlySet<string>;
  selectable: boolean;
  onToggle: (id: string) => void;
  onToggleAll: (all: boolean) => void;
  onOpen: (c: Contact) => void;
}) {
  const label = new Map(catalog.map((c) => [c.key, c.label]));
  const byKey = new Map(fields.map((f) => [`cf:${f.key}`, f]));
  const all = items.length > 0 && items.every((c) => selected.has(c.id));
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table aria-label="Contactos" className="w-full min-w-max border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-muted">
            {selectable ? (
              <th className="w-9 px-3 py-2.5">
                <input type="checkbox" aria-label="Seleccionar todos los contactos que se ven" checked={all} onChange={(e) => onToggleAll(e.target.checked)} />
              </th>
            ) : null}
            {columns.map((k) => <th key={k} scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold">{label.get(k) ?? k}</th>)}
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id} className={`border-b border-line last:border-0 ${selected.has(c.id) ? 'bg-accent-soft' : 'hover:bg-surface2'}`}>
              {selectable ? (
                <td className="px-3 py-2.5">
                  <input type="checkbox" aria-label={`Seleccionar a ${c.name}`} checked={selected.has(c.id)} onChange={() => onToggle(c.id)} />
                </td>
              ) : null}
              {columns.map((k) => <td key={k} className="px-3 py-2.5 align-middle"><Cell c={c} col={k} field={byKey.get(k)} onOpen={onOpen} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
