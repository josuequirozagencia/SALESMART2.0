import { SOURCE_LABEL } from '../../lib/format';
import type { ContactTag, OwnerOption } from '../../lib/types';
import { Button } from '../../ui/controls';
import { NO_OPP_FILTERS, type OpportunityFilters } from './useOpportunities';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] font-normal';

/** Filtros del tablero (ADR-49 #7): búsqueda, responsable (solo quien ve todo), origen, etiqueta y valor mínimo. */
export function OpportunityFilterPanel({ filters, onChange, text, onText, viewAll, owners, tags }: { filters: OpportunityFilters; onChange: (f: OpportunityFilters) => void; text: string; onText: (t: string) => void; viewAll: boolean; owners: OwnerOption[]; tags: ContactTag[] }) {
  return (
    <div role="group" aria-label="Filtros de oportunidades" className="grid gap-3 rounded-2xl border border-line bg-surface p-3 min-[640px]:grid-cols-2 min-[900px]:grid-cols-5">
      <label className="grid gap-1 text-[12px] font-semibold">Buscar
        <input type="search" value={text} onChange={(e) => onText(e.target.value)} placeholder="Nombre, correo o teléfono" aria-label="Buscar oportunidades" className={selectCls} />
      </label>
      {viewAll ? (
        <label className="grid gap-1 text-[12px] font-semibold">Responsable
          <select aria-label="Filtrar por responsable" value={filters.owner} onChange={(e) => onChange({ ...filters, owner: e.target.value })} className={selectCls}>
            <option value="">Todos</option>
            <option value="me">Míos</option>
            <option value="none">Sin asignar</option>
            {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      ) : null}
      <label className="grid gap-1 text-[12px] font-semibold">Origen
        <select aria-label="Filtrar por origen" value={filters.source} onChange={(e) => onChange({ ...filters, source: e.target.value })} className={selectCls}>
          <option value="">Todos</option>
          {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-[12px] font-semibold">Etiqueta
        <select aria-label="Filtrar por etiqueta" value={filters.tags[0] ?? ''} onChange={(e) => onChange({ ...filters, tags: e.target.value ? [e.target.value] : [] })} className={selectCls}>
          <option value="">Todas</option>
          {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-[12px] font-semibold">Valor mínimo (USD)
        <input value={filters.min} onChange={(e) => onChange({ ...filters, min: e.target.value })} inputMode="decimal" aria-label="Valor mínimo" placeholder="Cualquiera" className={selectCls} />
      </label>
      <div className="flex items-end"><Button onClick={() => { onText(''); onChange(NO_OPP_FILTERS); }}>Limpiar filtros</Button></div>
    </div>
  );
}
