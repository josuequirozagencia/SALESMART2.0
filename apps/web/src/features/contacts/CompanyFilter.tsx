import { useEffect, useState } from 'react';
import { Spinner } from '../../ui/controls';
import { useCompanies } from '../crm/useCrm';

/**
 * Filtro por empresa de la tabla de contactos (M10.2, ADR-56): se busca por nombre y se elige una; la elegida queda como etiqueta de filtro (en `FilterBar`) que se quita con la ×.
 * Busca en las empresas de toda la organización (compartidas, ADR-48); los contactos que salen son solo los que la persona puede ver.
 */
export function CompanyFilter({ onPick }: { onPick: (c: { id: string; name: string }) => void }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const found = useCompanies(q);
  const items = found.data?.pages[0]?.items ?? [];
  return (
    <div className="relative grid gap-1 text-[12px] font-semibold">
      <label className="grid gap-1">Empresa
        <input type="search" aria-label="Filtrar por empresa" value={text} onChange={(e) => setText(e.target.value)} placeholder="Buscar una empresa" className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] font-normal" />
      </label>
      {q ? (
        <ul aria-label="Empresas encontradas" className="absolute left-0 top-full z-20 mt-1 grid max-h-56 w-[min(18rem,80vw)] gap-0.5 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow)]">
          {found.isPending ? <li className="px-2 py-1.5"><Spinner label="Buscando empresas" /></li> : null}
          {found.isSuccess && items.length === 0 ? <li className="px-2 py-1.5 text-[12.5px] font-normal text-muted">Ninguna empresa coincide.</li> : null}
          {items.map((c) => (
            <li key={c.id}>
              <button type="button" aria-label={`Filtrar por la empresa ${c.name}`} onClick={() => { setText(''); setQ(''); onPick({ id: c.id, name: c.name }); }} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-normal hover:bg-surface2">
                <span className="truncate">{c.name}</span>
                <span className="shrink-0 text-[11.5px] text-muted">{c.contact_count} {c.contact_count === 1 ? 'contacto' : 'contactos'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
