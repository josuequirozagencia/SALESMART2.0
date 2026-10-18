import { useEffect, useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Contact, ContactAccess, SavedFilters, SavedList } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { useTags } from '../tags/useTags';
import { ColumnMenu } from './ColumnMenu';
import { catalogOf, loadColumns, normalizeColumns, saveColumns } from './columns';
import { ContactDialog } from './ContactDialog';
import { ContactsTable } from './ContactsTable';
import { ExportDialog } from './ExportDialog';
import { FilterBar } from './FilterBar';
import { ImportDialog } from './ImportDialog';
import { ListDialog, type ListMode } from './ListDialog';
import { NO_CONTACT_FILTERS, SORT_LABEL, SORT_PARAMS, hasFilters, useContacts, useOwners, type ContactFilters, type SortKey } from './useContacts';
import { useAddMembers, useLists, useUpdateList } from './useLists';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px]';
// Mientras llega la primera página no se sabe qué puede hacer la persona: no se ofrece nada
const NO_ACCESS: ContactAccess = { view_all: false, write: false, delete: false, import: false, export: false };

const sortKeyOf = (s: { key: string; order: string } | null): SortKey => (Object.keys(SORT_PARAMS) as SortKey[]).find((k) => SORT_PARAMS[k].sort === s?.key && SORT_PARAMS[k].order === s.order) ?? 'recent';
const sortOf = (k: SortKey) => ({ key: SORT_PARAMS[k].sort, order: SORT_PARAMS[k].order });

/** Filtros de la pantalla → los que se guardan en una lista dinámica. */
function toSaved(f: ContactFilters): SavedFilters {
  return {
    ...(f.q.trim() ? { q: f.q.trim() } : {}),
    ...(f.owner ? { owner: f.owner } : {}),
    ...(f.consent ? { consent: f.consent } : {}),
    ...(f.tags.length > 0 ? { tag: f.tags } : {}),
    ...(f.cf.length > 0 ? { cf: f.cf } : {}),
  };
}
/** Filtros guardados de una lista dinámica → los de la pantalla. */
function fromSaved(s: SavedFilters, sort: SavedList['sort']): ContactFilters {
  return { q: s.q ?? '', owner: s.owner ?? '', consent: s.consent ?? '', tags: s.tag ?? [], cf: s.cf ?? [], sort: sortKeyOf(sort) };
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Contactos (M3.1–M3.4, ADR-43/46). Tabla con columnas configurables, filtros (consentimiento, etiquetas, campos personalizados), listas guardadas (dinámicas
 * con filtros y fijas con contactos elegidos) y selección. El servidor decide qué contactos ve la persona y qué puede hacer (`access`); aquí solo se muestra.
 */
export function ContactsPage() {
  const [text, setText] = useState('');
  const [filters, setFilters] = useState<ContactFilters>(NO_CONTACT_FILTERS);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cols, setCols] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<{ contact?: Contact } | null>(null);
  const [listDialog, setListDialog] = useState<ListMode | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [target, setTarget] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string }>();

  const fieldsQ = useCustomFields();
  const tagsQ = useTags();
  const listsQ = useLists();
  const fields = useMemo(() => fieldsQ.data?.items ?? [], [fieldsQ.data]);
  const tags = useMemo(() => tagsQ.data?.items ?? [], [tagsQ.data]);
  const lists = useMemo(() => listsQ.data ?? [], [listsQ.data]);
  const catalog = useMemo(() => catalogOf(fields), [fields]);
  // Una lista recién creada se usa al instante, antes de que la consulta de listas se refresque
  const [fresh, setFresh] = useState<SavedList | null>(null);
  const active = lists.find((l) => l.id === activeId) ?? (fresh && fresh.id === activeId ? fresh : null);

  const q = useContacts(filters, active?.kind === 'fixed' ? active.id : undefined);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const first = q.data?.pages[0];
  const access = first?.access ?? NO_ACCESS;
  const total = first?.total ?? null;
  const owners = useOwners(access.view_all);
  const update = useUpdateList();
  const addMembers = useAddMembers();
  const filtered = hasFilters(filters);

  const columns = useMemo(() => normalizeColumns(cols ?? (active ? active.columns : loadColumns()), catalog), [cols, active, catalog]);
  const canEdit = (l: SavedList): boolean => l.mine || (l.shared && access.view_all);
  const savedSort = sortOf(filters.sort);

  // Cambios sin guardar de la lista abierta (filtros solo en las dinámicas, columnas y orden en todas)
  const dirty = useMemo(() => {
    if (!active) return false;
    const baseCols = normalizeColumns(active.columns, catalog);
    const filtersChanged = active.kind === 'dynamic' && !same(toSaved(filters), toSaved(fromSaved(active.filters, active.sort)));
    return filtersChanged || !same(columns, baseCols) || sortKeyOf(active.sort) !== filters.sort;
  }, [active, catalog, columns, filters]);

  // Búsqueda con espera: no se consulta en cada tecla
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === text.trim() ? f : { ...f, q: text.trim() })), 300);
    return () => clearTimeout(t);
  }, [text]);

  function changeFilters(f: ContactFilters) {
    setFilters(f);
    setSelected(new Set());
  }
  function openTab(l: SavedList | null) {
    setActiveId(l?.id ?? null);
    setSelected(new Set());
    setCols(null);
    setNotice(undefined);
    const f = !l ? NO_CONTACT_FILTERS : l.kind === 'dynamic' ? fromSaved(l.filters, l.sort) : { ...NO_CONTACT_FILTERS, sort: sortKeyOf(l.sort) };
    setFilters(f);
    setText(f.q);
  }
  function changeColumns(next: string[]) {
    setCols(next);
    if (!active) saveColumns(next);
  }
  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  }
  function saveChanges() {
    if (!active) return;
    setNotice(undefined);
    update.mutate(
      { id: active.id, patch: { ...(active.kind === 'dynamic' ? { filters: toSaved(filters) } : {}), columns, sort: savedSort } },
      { onSuccess: () => { setCols(null); setNotice({ kind: 'ok', text: 'Cambios guardados en la lista.' }); }, onError: (e) => setNotice({ kind: 'error', text: friendlyError(e, 'No pudimos guardar los cambios.') }) },
    );
  }
  function addToList() {
    if (!target) return;
    setNotice(undefined);
    addMembers.mutate(
      { id: target, ids: [...selected] },
      {
        onSuccess: (r) => { setNotice({ kind: 'ok', text: r.added === 0 ? 'Esos contactos ya estaban en la lista.' : `Se agregaron ${r.added} contacto${r.added === 1 ? '' : 's'} a la lista.` }); setSelected(new Set()); setTarget(''); },
        onError: (e) => setNotice({ kind: 'error', text: friendlyError(e, 'No pudimos agregar los contactos.') }),
      },
    );
  }

  const fixedTargets = lists.filter((l) => l.kind === 'fixed' && canEdit(l));
  const readOnly = !access.write;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-bold">Contactos</h1>
        <div className="flex flex-wrap items-center gap-2">
          <ColumnMenu catalog={catalog} selected={columns} onChange={changeColumns} />
          {access.export ? <Button onClick={() => setExporting(true)}>Exportar</Button> : null}
          {access.import ? <Button onClick={() => setImporting(true)}>Importar</Button> : null}
          {access.write ? <Button variant="primary" onClick={() => setDialog({})}>Nuevo contacto</Button> : null}
        </div>
      </div>

      <div role="tablist" aria-label="Listas" className="flex flex-wrap items-center gap-1.5">
        <button type="button" role="tab" aria-selected={active === null} onClick={() => openTab(null)} className={`rounded-full border px-3 py-1 text-[13px] font-semibold ${active === null ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>Todos</button>
        {lists.map((l) => (
          <span key={l.id} className="inline-flex items-center gap-1">
            <button type="button" role="tab" aria-selected={active?.id === l.id} onClick={() => openTab(l)} className={`rounded-full border px-3 py-1 text-[13px] font-semibold ${active?.id === l.id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>
              {l.name}{l.member_count !== null ? <span className="font-normal text-muted"> · {l.member_count}</span> : null}{l.shared ? <span className="font-normal text-muted" title="Compartida con la empresa"> · compartida</span> : null}
            </button>
            {active?.id === l.id && canEdit(l) && access.write ? <button type="button" aria-label={`Editar la lista ${l.name}`} onClick={() => setListDialog({ kind: 'edit', list: l })} className="px-1 text-[13px] text-muted hover:text-fg">✎</button> : null}
          </span>
        ))}
        {access.write ? <button type="button" onClick={() => setListDialog({ kind: 'filters' })} className="rounded-full border border-dashed border-line px-3 py-1 text-[13px] text-muted hover:text-fg">+ Nueva lista</button> : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="grid flex-1 gap-1 text-[12px] font-semibold min-[640px]:max-w-[320px]">Buscar
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Nombre, correo o teléfono" className={`${selectCls} font-normal`} />
        </label>
        {access.view_all ? (
          <label className="grid gap-1 text-[12px] font-semibold">Responsable
            <select aria-label="Responsable" value={filters.owner} onChange={(e) => changeFilters({ ...filters, owner: e.target.value })} className={`${selectCls} font-normal`}>
              <option value="">Todos</option>
              <option value="me">Míos</option>
              <option value="none">Sin asignar</option>
              {(owners.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
        ) : null}
        <label className="grid gap-1 text-[12px] font-semibold">Orden
          <select aria-label="Orden" value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as SortKey }))} className={`${selectCls} font-normal`}>
            {(Object.keys(SORT_LABEL) as SortKey[]).map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
          </select>
        </label>
        {filtered ? <Button variant="link" onClick={() => { setText(''); changeFilters({ ...NO_CONTACT_FILTERS, sort: filters.sort }); }}>Limpiar filtros</Button> : null}
      </div>
      <FilterBar filters={filters} onChange={changeFilters} tags={tags} fields={fields.filter((f) => f.archived_at === null)} />

      {active && dirty && canEdit(active) && access.write ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-info-soft px-3 py-2 text-[13px] text-info">
          Cambiaste {active.kind === 'dynamic' ? 'los filtros, ' : ''}las columnas o el orden de esta lista.
          <Button className="!px-3 !py-1.5 !text-[12.5px]" loading={update.isPending} onClick={saveChanges}>Guardar cambios en la lista</Button>
        </div>
      ) : null}
      {notice ? <Alert kind={notice.kind}>{notice.text}</Alert> : null}

      {selected.size > 0 ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-accent bg-accent-soft px-3 py-2 text-[13px]">
          <b>{selected.size} seleccionado{selected.size === 1 ? '' : 's'}</b>
          <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setListDialog({ kind: 'selection', ids: [...selected] })}>Crear lista con la selección</Button>
          {fixedTargets.length > 0 ? (
            <span className="flex items-center gap-1.5">
              <select aria-label="Lista a la que agregar" value={target} onChange={(e) => setTarget(e.target.value)} className={selectCls}>
                <option value="">Agregar a una lista…</option>
                {fixedTargets.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <Button className="!px-3 !py-1.5 !text-[12.5px]" disabled={!target} loading={addMembers.isPending} onClick={addToList}>Agregar</Button>
            </span>
          ) : null}
          <Button variant="link" onClick={() => setSelected(new Set())}>Quitar selección</Button>
        </div>
      ) : null}

      {total !== null ? <p className="text-[12.5px] text-muted" aria-live="polite">{total === 1 ? '1 contacto' : `${total} contactos`}{filtered ? ' con estos filtros' : ''}{access.view_all ? '' : ' asignados a ti'}</p> : null}

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando contactos" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los contactos.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">
          {filtered ? 'Ningún contacto coincide con los filtros.' : active ? 'Esta lista no tiene contactos.' : access.write ? 'Todavía no hay contactos. Crea el primero con «Nuevo contacto».' : 'Todavía no hay contactos.'}
        </p>
      ) : null}
      {items.length > 0 ? (
        <ContactsTable
          items={items}
          columns={columns}
          catalog={catalog}
          fields={fields}
          selected={selected}
          selectable={!readOnly}
          onToggle={toggle}
          onToggleAll={(all) => setSelected(all ? new Set(items.map((c) => c.id)) : new Set())}
          onOpen={(c) => setDialog({ contact: c })}
        />
      ) : null}
      {q.hasNextPage ? <div className="grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}

      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
      {exporting ? (
        <ExportDialog
          selectedIds={[...selected]}
          filters={filters}
          listId={active?.kind === 'fixed' ? active.id : undefined}
          listName={active?.name}
          visibleColumns={columns}
          total={total}
          onClose={() => setExporting(false)}
        />
      ) : null}
      {dialog ? (
        <ContactDialog
          {...(dialog.contact ? { contact: items.find((c) => c.id === dialog.contact!.id) ?? dialog.contact } : {})}
          owners={owners.data ?? []}
          canAssign={access.view_all}
          canDelete={access.delete}
          readOnly={readOnly}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {listDialog ? (
        <ListDialog
          mode={listDialog}
          filters={toSaved(filters)}
          columns={columns}
          sort={savedSort}
          canShare={access.view_all}
          onClose={() => setListDialog(null)}
          onDone={(l) => {
            const edited = listDialog.kind === 'edit';
            setListDialog(null);
            if (l === null) openTab(null);
            else if (!edited) {
              setFresh(l);
              openTab(l);
            }
          }}
        />
      ) : null}
    </div>
  );
}
