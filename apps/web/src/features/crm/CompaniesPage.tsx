import { useEffect, useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { formatPhone } from '../../lib/phone';
import type { CrmCompany } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { ContactsTabs } from '../contacts/ContactsTabs';
import { useOwners } from '../contacts/useContacts';
import { CompanyDialog } from './CompanyDialog';
import { useCompanies } from './useCrm';

/**
 * Empresas (M3.6, ADR-48). Compartidas por toda la organización; el número de contactos de cada una es el de los contactos que la persona puede ver.
 * El servidor informa qué puede hacer (`access`); aquí solo se muestran u ocultan botones.
 */
export function ClientCompaniesPage() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<{ company?: CrmCompany } | null>(null);
  const list = useCompanies(q);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const access = list.data?.pages[0]?.access ?? { manage: false, write: false };
  // Quien puede asignar tareas (ve todos los contactos) necesita la lista de personas; sin permiso el servidor responde 403 y queda vacía
  const owners = useOwners(true);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">Contactos</h1>
        {access.manage ? <Button variant="primary" onClick={() => setDialog({})}>Nueva empresa</Button> : null}
      </div>
      <ContactsTabs />
      <label className="grid gap-1 text-[12px] font-semibold min-[640px]:max-w-[320px]">Buscar
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Nombre de la empresa" className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] font-normal" />
      </label>
      {list.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando empresas" /></div> : null}
      {list.isError ? <Alert>{friendlyError(list.error, 'No pudimos cargar las empresas.')} <Button variant="link" onClick={() => void list.refetch()}>Reintentar</Button></Alert> : null}
      {list.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">
          {q ? 'Ninguna empresa coincide con la búsqueda.' : access.manage ? 'Todavía no hay empresas. Crea la primera con «Nueva empresa».' : 'Todavía no hay empresas.'}
        </p>
      ) : null}
      {items.length > 0 ? (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table aria-label="Empresas" className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="px-3 py-2 font-semibold">Nombre</th>
                <th className="px-3 py-2 font-semibold">Sitio web</th>
                <th className="px-3 py-2 font-semibold">Teléfono</th>
                <th className="px-3 py-2 text-right font-semibold">Contactos</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2"><button type="button" aria-label={`Abrir la empresa ${c.name}`} onClick={() => setDialog({ company: c })} className="max-w-[260px] truncate text-left font-semibold text-accent hover:underline">{c.name}</button></td>
                  <td className="max-w-[200px] truncate px-3 py-2 text-muted">{c.website ?? '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{c.phone ? formatPhone(c.phone) : '—'}</td>
                  <td className="px-3 py-2 text-right">{c.contact_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.hasNextPage ? <div className="grid place-items-center"><Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Cargar más</Button></div> : null}
      {dialog ? (
        <CompanyDialog
          {...(dialog.company ? { company: items.find((c) => c.id === dialog.company!.id) ?? dialog.company } : {})}
          canManage={access.manage}
          canWrite={access.write}
          viewAll={(owners.data ?? []).length > 0}
          owners={owners.data ?? []}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
