import { useEffect, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { CompanyRef, Contact } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { useCompanies, useCreateCompany, useLinkCompany, useUnlinkCompany } from './useCrm';

export const MAX_COMPANIES = 5;

/**
 * Campo «Empresa» del formulario del contacto (M10.2, ADR-56; modelo y permisos de ADR-48 sin cambios). OPCIONAL. Se busca una empresa existente por nombre y, si no existe y la
 * persona administra empresas (`companies.manage`, que el servidor informa en `access.manage`), se crea al vuelo con el texto buscado. Quien no puede administrarlas ve el campo
 * deshabilitado con la explicación (el servidor ya rechazaría el vínculo): el asesor ve las empresas de su contacto, no las cambia.
 *  - Contacto NUEVO (`contact` ausente): la elección se guarda en el formulario (`value`) y el diálogo la vincula al crear el contacto.
 *  - Contacto existente: agregar y quitar actúan al instante (las mismas rutas de siempre) y la lista sale del propio contacto.
 */
export function CompanyField({ contact, value, onChange, disabled }: { contact?: Contact | undefined; value: CompanyRef[]; onChange: (v: CompanyRef[]) => void; disabled: boolean }) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string>();
  const link = useLinkCompany();
  const unlink = useUnlinkCompany();
  const create = useCreateCompany();
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const found = useCompanies(q);
  const access = found.data?.pages[0]?.access;
  const manage = access?.manage === true && !disabled;
  const current: CompanyRef[] = contact ? contact.companies : value;
  const taken = new Set(current.map((c) => c.id));
  const options = (found.data?.pages[0]?.items ?? []).filter((c) => !taken.has(c.id)).slice(0, 6);
  const exact = (found.data?.pages[0]?.items ?? []).some((c) => c.name.toLowerCase() === q.toLowerCase());
  const full = current.length >= MAX_COMPANIES;
  const busy = link.isPending || unlink.isPending || create.isPending;

  const add = (c: CompanyRef): void => {
    setError(undefined);
    if (contact) link.mutate({ contactId: contact.id, companyId: c.id }, { onSuccess: () => setText(''), onError: (e) => setError(friendlyError(e, 'No pudimos vincular la empresa.')) });
    else { onChange([...value, { id: c.id, name: c.name }]); setText(''); }
  };
  const remove = (c: CompanyRef): void => {
    setError(undefined);
    if (contact) unlink.mutate({ contactId: contact.id, companyId: c.id }, { onError: (e) => setError(friendlyError(e, 'No pudimos quitar la empresa.')) });
    else onChange(value.filter((x) => x.id !== c.id));
  };
  const createAndAdd = (): void => {
    setError(undefined);
    create.mutate({ name: text.trim(), website: null, phone: null, email: null }, { onSuccess: (c) => add({ id: c.id, name: c.name }), onError: (e) => setError(friendlyError(e, 'No pudimos crear la empresa.')) });
  };

  return (
    <fieldset className="grid gap-2" aria-label="Empresa">
      <legend className="text-[12.5px] font-semibold">Empresa <span className="font-normal text-muted">(opcional)</span></legend>
      {current.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Empresas del contacto">
          {current.map((c) => (
            <li key={c.id} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[13px]">
              {c.name}
              {manage ? <button type="button" aria-label={`Quitar la empresa ${c.name}`} disabled={busy} onClick={() => remove(c)} className="text-muted hover:text-fg">×</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {full ? <p className="text-[12.5px] text-muted">Un contacto puede pertenecer a {MAX_COMPANIES} empresas como máximo.</p> : (
        <div className="grid gap-1.5">
          <input
            type="search"
            aria-label="Buscar o crear una empresa"
            value={text}
            disabled={!manage}
            onChange={(e) => setText(e.target.value)}
            placeholder={manage ? 'Busca por nombre o escribe una nueva' : 'Solo un administrador puede vincular empresas'}
            className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] font-normal disabled:opacity-60"
          />
          {!manage && !disabled && found.isSuccess ? <p className="text-[12px] text-muted">Solo un administrador puede vincular empresas a un contacto.</p> : null}
          {manage && q ? (
            <ul className="grid gap-1" aria-label="Empresas encontradas">
              {found.isPending ? <li><Spinner label="Buscando empresas" /></li> : null}
              {options.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px]">
                  {c.name}
                  <Button type="button" className="!px-3 !py-1 !text-[12px]" aria-label={`Elegir la empresa ${c.name}`} disabled={busy} onClick={() => add(c)}>Elegir</Button>
                </li>
              ))}
              {found.isSuccess && !exact ? (
                <li>
                  <Button type="button" className="!px-3 !py-1.5 !text-[12.5px]" loading={create.isPending} disabled={busy} onClick={createAndAdd}>Crear «{q}»</Button>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      )}
      {error ? <Alert>{error}</Alert> : null}
    </fieldset>
  );
}
