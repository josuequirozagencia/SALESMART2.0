import { useEffect, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Contact } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { useCompanies, useLinkCompany, useUnlinkCompany } from './useCrm';

const MAX_COMPANIES = 5;

/**
 * Empresas de un contacto (M3.6, ADR-48): hasta 5; se agregan buscando por nombre y se quitan con un clic. Solo quien administra empresas puede cambiarlas
 * (el servidor lo informa en `access.manage`); la empresa se crea desde «Empresas».
 */
export function ContactCompaniesPanel({ contact, canWrite }: { contact: Contact; canWrite: boolean }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string>();
  const link = useLinkCompany();
  const unlink = useUnlinkCompany();
  // Búsqueda con espera: no se consulta en cada tecla
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const found = useCompanies(q);
  const linked = new Set(contact.companies.map((c) => c.id));
  const options = (found.data?.pages[0]?.items ?? []).filter((c) => !linked.has(c.id));
  const manage = canWrite && found.data?.pages[0]?.access.manage === true;
  const full = contact.companies.length >= MAX_COMPANIES;

  const fail = (e: unknown, fallback: string) => setError(friendlyError(e, fallback));
  return (
    <section aria-label="Empresas" className="grid gap-3">
      {contact.companies.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">Este contacto no pertenece a ninguna empresa.</p> : null}
      <ul className="flex flex-wrap gap-2">
        {contact.companies.map((c) => (
          <li key={c.id} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[13px]">
            {c.name}
            {manage ? <button type="button" aria-label={`Quitar de la empresa ${c.name}`} disabled={unlink.isPending} onClick={() => { setError(undefined); unlink.mutate({ contactId: contact.id, companyId: c.id }, { onError: (e) => fail(e, 'No pudimos quitar la empresa.') }); }} className="text-muted hover:text-fg">×</button> : null}
          </li>
        ))}
      </ul>
      {manage ? (
        full ? <Alert kind="info">Un contacto puede pertenecer a {MAX_COMPANIES} empresas como máximo.</Alert> : (
          <div className="grid gap-2">
            <label className="grid gap-1 text-[12px] font-semibold">Agregar a una empresa
              <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Busca por nombre" className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] font-normal" />
            </label>
            {found.isPending ? <Spinner label="Buscando empresas" /> : null}
            {found.isSuccess && options.length === 0 ? <p className="text-[12.5px] text-muted">{q ? 'Ninguna empresa coincide.' : 'No hay más empresas para agregar. Crea una en la sección «Empresas».'}</p> : null}
            <ul className="grid gap-1">
              {options.slice(0, 8).map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px]">
                  {c.name}
                  <Button className="!px-3 !py-1 !text-[12px]" aria-label={`Agregar a la empresa ${c.name}`} loading={link.isPending && link.variables?.companyId === c.id} onClick={() => { setError(undefined); link.mutate({ contactId: contact.id, companyId: c.id }, { onError: (e) => fail(e, 'No pudimos agregar la empresa.') }); }}>Agregar</Button>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}
      {canWrite && found.isSuccess && !manage ? <p className="text-[12.5px] text-muted">Solo el administrador cambia las empresas de un contacto.</p> : null}
      {error ? <Alert>{error}</Alert> : null}
    </section>
  );
}
