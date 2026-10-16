import { useEffect, useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDate } from '../../lib/format';
import { formatPhone } from '../../lib/phone';
import type { Consent, Contact, ContactAccess } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill, type PillKind } from '../../ui/Pill';
import { ContactDialog } from './ContactDialog';
import { NO_CONTACT_FILTERS, SORT_LABEL, useContacts, useOwners, type ContactFilters, type SortKey } from './useContacts';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';
const CONSENT: Record<Consent, [PillKind, string]> = { granted: ['ok', 'Con consentimiento'], revoked: ['crit', 'Sin consentimiento'], unknown: ['muted', 'Consentimiento sin definir'] };
// Mientras llega la primera página no se sabe qué puede hacer la persona: no se ofrece nada
const NO_ACCESS: ContactAccess = { view_all: false, write: false, delete: false };

function Row({ c, onOpen }: { c: Contact; onOpen: (c: Contact) => void }) {
  const [kind, label] = CONSENT[c.consent];
  const first = c.phones[0];
  return (
    <li>
      <button type="button" aria-label={`Abrir el contacto ${c.name}`} onClick={() => onOpen(c)} className="grid w-full gap-2 rounded-2xl border border-line bg-surface p-4 text-left hover:bg-surface2 min-[900px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] min-[900px]:items-center min-[900px]:gap-3">
        <span className="min-w-0">
          <b className="block truncate text-[14px]">{c.name}</b>
          <span className="block truncate text-[12px] text-muted">{c.email ?? 'Sin correo'}</span>
        </span>
        <span className="min-w-0 text-[13px]">
          {first ? <span className="block truncate">{formatPhone(first.e164)}{c.phones.length > 1 ? <span className="text-muted"> · +{c.phones.length - 1} más</span> : null}</span> : <span className="text-muted">Sin teléfono</span>}
        </span>
        <span className="min-w-0 text-[12.5px] text-muted">
          <span className="block truncate">{c.owner ? c.owner.name : 'Sin asignar'}</span>
          <span className="block">Creado el {shortDate(c.created_at)}</span>
        </span>
        <span className="justify-self-start min-[900px]:justify-self-end"><Pill kind={kind}>{label}</Pill></span>
      </button>
    </li>
  );
}

/**
 * Contactos (M3.1, ADR-43). Busca por nombre, correo o teléfono; ordena; filtra por responsable (solo quien ve todos los contactos) y pagina por
 * cursor. El servidor acota qué contactos ve la persona (los suyos, o todos) y dice qué puede hacer (`access`): aquí solo se muestra u oculta.
 */
export function ContactsPage() {
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<ContactFilters>(NO_CONTACT_FILTERS);
  const [dialog, setDialog] = useState<{ contact?: Contact } | null>(null);
  const q = useContacts(filters);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const first = q.data?.pages[0];
  const access = first?.access ?? NO_ACCESS;
  const total = first?.total ?? null;
  const owners = useOwners(access.view_all);
  const filtered = Boolean(filters.q || filters.owner);

  // Búsqueda con espera: no se consulta en cada tecla
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text.trim() ? f : { ...f, q: text.trim() })), 300);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">Contactos</h1>
        {access.write ? <Button variant="primary" onClick={() => setDialog({})}>Nuevo contacto</Button> : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="grid flex-1 gap-1 text-[12px] font-semibold min-[640px]:max-w-[320px]">Buscar
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Nombre, correo o teléfono" className={`${selectCls} font-normal`} />
        </label>
        {access.view_all ? (
          <label className="grid gap-1 text-[12px] font-semibold">Responsable
            <select value={filters.owner} onChange={(e) => setFilters((f) => ({ ...f, owner: e.target.value }))} className={`${selectCls} font-normal`}>
              <option value="">Todos</option>
              <option value="me">Míos</option>
              <option value="none">Sin asignar</option>
              {(owners.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        ) : null}
        <label className="grid gap-1 text-[12px] font-semibold">Orden
          <select value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as SortKey }))} className={`${selectCls} font-normal`}>
            {(Object.keys(SORT_LABEL) as SortKey[]).map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
          </select>
        </label>
        {filtered ? <Button variant="link" onClick={() => { setText(''); setFilters((f) => ({ ...NO_CONTACT_FILTERS, sort: f.sort })); }}>Limpiar filtros</Button> : null}
      </div>

      {total !== null ? <p className="text-[12.5px] text-muted" aria-live="polite">{total === 1 ? '1 contacto' : `${total} contactos`}{filtered ? ' con estos filtros' : ''}{access.view_all ? '' : ' asignados a ti'}</p> : null}

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando contactos" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los contactos.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">
          {filtered ? 'Ningún contacto coincide con los filtros.' : access.write ? 'Todavía no hay contactos. Crea el primero con «Nuevo contacto».' : 'Todavía no hay contactos.'}
        </p>
      ) : null}
      {items.length > 0 ? <ul className="grid gap-2" aria-label="Contactos">{items.map((c) => <Row key={c.id} c={c} onOpen={(x) => setDialog({ contact: x })} />)}</ul> : null}
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}

      {dialog ? (
        <ContactDialog
          {...(dialog.contact ? { contact: dialog.contact } : {})}
          owners={owners.data ?? []}
          canAssign={access.view_all}
          canDelete={access.delete}
          readOnly={!access.write}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
