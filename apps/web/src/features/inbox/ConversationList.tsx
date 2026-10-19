import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import { initials } from '../../lib/format';
import type { Conversation, InboxFilters, InboxTab } from '../../lib/types';
import { useNow } from '../../lib/useNow';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { chatTime, STATUS_PILL } from './inboxFormat';
import { SlaPill } from './SlaPill';
import { activeFilterCount, DEFAULT_INBOX_FILTERS, useConversations, useInboxOptions } from './useInbox';

const TABS: Array<{ id: InboxTab; label: string; hint: string }> = [
  { id: 'working', label: 'Trabajando', hint: 'Conversaciones en curso, incluso las que esperan respuesta del cliente' },
  { id: 'pending', label: 'Pendientes', hint: 'Asignadas que aún no se aceptan y, para quien ve todo, las que no tienen asesor' },
  { id: 'closed', label: 'Finalizadas', hint: 'Conversaciones cerradas' },
];

const selectCls = 'w-full rounded-[10px] border border-line bg-surface px-2.5 py-1.5 text-[13px]';

function Row({ c, active, now }: { c: Conversation; active: boolean; now: number }) {
  const status = STATUS_PILL[c.status];
  const last = c.last_message;
  const unread = c.unread_count > 0;
  return (
    <li>
      <Link
        to={`/inbox/${c.id}`}
        aria-current={active ? 'true' : undefined}
        aria-label={`${c.contact.name}${unread ? `, ${c.unread_count} sin leer` : ''}`}
        className={`grid grid-cols-[42px_minmax(0,1fr)] gap-2.5 border-b border-line px-3 py-2.5 hover:bg-surface2 ${active ? 'bg-accent-soft' : ''}`}
      >
        <span aria-hidden="true" className="grid size-[42px] place-items-center rounded-full bg-surface2 text-[13px] font-bold text-muted">{initials(c.contact.name)}</span>
        <span className="grid min-w-0 gap-0.5">
          <span className="flex items-baseline gap-2">
            <b className="min-w-0 flex-1 truncate text-[14px]">{c.contact.name}</b>
            <time dateTime={c.last_message_at ?? undefined} className={`shrink-0 text-[11px] ${unread ? 'font-semibold text-ok' : 'text-muted'}`}>{chatTime(c.last_message_at, now)}</time>
          </span>
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
            <span className="min-w-0 flex-1 truncate">
              {last?.direction === 'out' ? <span aria-label="Tú: " className="mr-1">{last.status === 'failed' ? '⚠' : '✓'}</span> : null}
              {last ? last.preview : 'Sin mensajes'}
            </span>
            {unread ? <span aria-hidden="true" className="grid min-w-[19px] place-items-center rounded-full bg-ok px-1.5 text-[11px] font-bold text-white">{c.unread_count}</span> : null}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <Pill kind={status.kind}>{status.label}</Pill>
            <SlaPill sla={c.sla} now={now} hideDone />
            {c.queue ? <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10.5px] font-semibold text-muted">{c.queue.name}</span> : null}
            {c.owner ? <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10.5px] font-semibold text-muted">{c.owner.name.split(' ')[0]}</span> : null}
            {c.my_access === 'collaborator_reply' || c.my_access === 'collaborator_view' ? <span className="rounded bg-info-soft px-1.5 py-0.5 text-[10.5px] font-semibold text-info" title="Te la compartieron">Compartida</span> : null}
            {c.tags.slice(0, 2).map((t) => <span key={t.id} className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-white" style={{ backgroundColor: t.color }}>{t.name}</span>)}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * Columna izquierda del Inbox: búsqueda, filtros, pestañas con sus conteos y las conversaciones. Los filtros viven en la página (se conservan al abrir una
 * conversación). Se vuelve a consultar cada 10 s mientras la pestaña está a la vista.
 */
export function ConversationList({ filters, onFilters, activeId, className = '' }: { filters: InboxFilters; onFilters: (f: InboxFilters) => void; activeId: string | undefined; className?: string }) {
  const q = useConversations(filters);
  const options = useInboxOptions();
  const [search, setSearch] = useState(filters.q);
  const [panel, setPanel] = useState(false);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const counts = q.data?.pages[0]?.counts ?? null;
  const filtered = activeFilterCount(filters);
  // Las horas relativas («hace 5 min», «Vence en 2 min») se cuentan desde el último dato que llegó: así un listado recién consultado nunca muestra un cronómetro «de hace un minuto»
  const now = Math.max(useNow(60_000), q.dataUpdatedAt);
  const set = (patch: Partial<InboxFilters>) => onFilters({ ...filters, ...patch });

  // La búsqueda espera a que se deje de escribir
  useEffect(() => {
    if (search === filters.q) return;
    const t = setTimeout(() => onFilters({ ...filters, q: search }), 300);
    return () => clearTimeout(t);
  }, [search, filters, onFilters]);

  const opts = options.data;
  const emptyText = filters.q || filtered ? 'No hay conversaciones con estos filtros.' : filters.tab === 'working' ? 'No tienes conversaciones en curso.' : filters.tab === 'pending' ? 'No hay conversaciones pendientes.' : 'Aún no hay conversaciones finalizadas.';

  return (
    <section aria-label="Conversaciones" className={`flex min-h-0 flex-col border-line bg-surface lg:border-r ${className}`}>
      <div className="grid gap-2 border-b border-line p-3 pb-0">
        <div className="flex items-center gap-2">
          <input type="search" aria-label="Buscar conversaciones" placeholder="Buscar por nombre o teléfono" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-0 flex-1 rounded-full border border-transparent bg-surface2 px-3.5 py-2 text-[13.5px] placeholder:text-muted/70" />
          <button type="button" aria-expanded={panel} aria-controls="inbox-filters" onClick={() => setPanel((p) => !p)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold ${panel || filtered ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>
            Filtros{filtered ? <span className="grid min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[10.5px] text-accent-ink">{filtered}</span> : null}
          </button>
        </div>
        {panel ? (
          <div id="inbox-filters" className="grid gap-2 rounded-xl border border-line bg-bg p-2.5">
            {opts && opts.owners.length > 0 ? (
              <label className="grid gap-1 text-[12px] font-semibold">Responsable
                <select aria-label="Responsable" value={filters.owner} onChange={(e) => set({ owner: e.target.value })} className={`${selectCls} font-normal`}>
                  <option value="">Todos</option>
                  {opts.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
            ) : null}
            {opts && opts.queues.length > 0 ? (
              <label className="grid gap-1 text-[12px] font-semibold">Cola
                <select aria-label="Cola" value={filters.queue} onChange={(e) => set({ queue: e.target.value })} className={`${selectCls} font-normal`}>
                  <option value="">Todas</option>
                  {opts.queues.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
            ) : null}
            {opts && opts.channels.length > 1 ? (
              <label className="grid gap-1 text-[12px] font-semibold">Conexión
                <select aria-label="Conexión" value={filters.channel} onChange={(e) => set({ channel: e.target.value })} className={`${selectCls} font-normal`}>
                  <option value="">Todas</option>
                  {opts.channels.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
            ) : null}
            {opts && opts.tags.length > 0 ? (
              <label className="grid gap-1 text-[12px] font-semibold">Etiqueta
                <select aria-label="Etiqueta" value={filters.tag} onChange={(e) => set({ tag: e.target.value })} className={`${selectCls} font-normal`}>
                  <option value="">Todas</option>
                  {opts.tags.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
            ) : null}
            <label className="grid gap-1 text-[12px] font-semibold">Tiempo de respuesta
              <select aria-label="Tiempo de respuesta" value={filters.sla} onChange={(e) => set({ sla: e.target.value as InboxFilters['sla'] })} className={`${selectCls} font-normal`}>
                <option value="">Todas</option>
                <option value="late">Vencidas</option>
                <option value="risk">En riesgo</option>
                <option value="ok">Al día</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" aria-label="Solo no leídas" checked={filters.unread} onChange={(e) => set({ unread: e.target.checked })} />
              Solo no leídas
            </label>
            {filtered ? <Button variant="link" className="justify-self-start text-[12.5px]" onClick={() => onFilters({ ...DEFAULT_INBOX_FILTERS, tab: filters.tab, q: filters.q })}>Limpiar filtros</Button> : null}
          </div>
        ) : null}
        <div role="tablist" aria-label="Estado de las conversaciones" className="flex">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" title={t.hint} aria-selected={filters.tab === t.id} onClick={() => set({ tab: t.id })} className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 py-2 text-[13px] font-semibold ${filters.tab === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}>
              {t.label}
              {counts ? <span className={`grid min-w-[18px] place-items-center rounded-full px-1.5 text-[10.5px] ${filters.tab === t.id ? 'bg-accent text-accent-ink' : 'bg-surface2 text-muted'}`}>{counts[t.id]}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando conversaciones" /></div> : null}
        {q.isError ? <div className="p-3"><Alert>{friendlyError(q.error, 'No pudimos cargar las conversaciones.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert></div> : null}
        {q.isSuccess && items.length === 0 ? <p className="p-6 text-center text-[13px] text-muted">{emptyText}</p> : null}
        <ul>{items.map((c) => <Row key={c.id} c={c} active={c.id === activeId} now={now} />)}</ul>
        {q.hasNextPage ? <div className="grid place-items-center p-3"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}
      </div>
    </section>
  );
}
