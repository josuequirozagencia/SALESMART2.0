import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { friendlyError } from '../../lib/errors';
import type { Conversation, InboxFilters, InboxOptions, InboxTab } from '../../lib/types';
import { useNow } from '../../lib/useNow';
import { useBreakpoint } from '../../ui/breakpoints';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Avatar } from '../../ui/Avatar';
import { Drawer } from '../../ui/Drawer';
import { Icon } from '../../ui/Icon';
import { Pill } from '../../ui/Pill';
import { SkeletonRows } from '../../ui/Skeleton';
import { TagBadge } from '../../ui/TagBadge';
import { ThemeToggle } from '../../ui/ThemeToggle';
import { AppNavContext } from '../app/AppNav';
import { ViewAsMenu } from '../context/ViewAs';
import { NotificationsBell } from '../notifications/NotificationsBell';
import { chatTime, listPreview, STATUS_PILL } from './inboxFormat';
import { SlaPill } from './SlaPill';
import { usePhotos } from '../photos/usePhotos';
import { activeFilterCount, DEFAULT_INBOX_FILTERS, useConversations, useInboxOptions } from './useInbox';

const TABS: Array<{ id: InboxTab; label: string; hint: string }> = [
  { id: 'working', label: 'Trabajando', hint: 'Conversaciones en curso, incluso las que esperan respuesta del cliente' },
  { id: 'pending', label: 'Esperando', hint: 'Asignadas que aún no se aceptan y, para quien ve todo, las que no tienen asesor' },
  { id: 'closed', label: 'Finalizadas', hint: 'Conversaciones cerradas' },
];

const selectCls = 'w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-1.5 text-[13px]';

/** Estado de entrega del último mensaje que mandó el equipo: un símbolo y su texto para quien no lo ve (no solo color). */
const DELIVERY: Record<string, { mark: string; text: string }> = {
  queued: { mark: '◷', text: 'en cola' },
  sent: { mark: '✓', text: 'enviado' },
  delivered: { mark: '✓✓', text: 'entregado' },
  read: { mark: '✓✓', text: 'leído' },
  failed: { mark: '⚠', text: 'no se pudo enviar' },
};

/** «QR» y «GoHighLevel»: de dónde viene la conversación, cuando no es WhatsApp oficial (v10: en la bandeja no se escribe «no oficial»; el aviso de riesgo vive en Configuración › Conexiones). */
function ChannelMark({ kind }: { kind: Conversation['channel']['kind'] }) {
  if (kind === 'qr') return <span className="rounded-full border border-warn bg-warn-soft px-1.5 py-px text-[11px] font-semibold text-warn" title="WhatsApp por QR">QR</span>;
  if (kind === 'ghl') return <span className="rounded-full bg-info-soft px-1.5 py-px text-[11px] font-semibold text-info">GoHighLevel</span>;
  return null;
}

function Row({ c, active, now, mobile, photo }: { c: Conversation; active: boolean; now: number; mobile: boolean; photo?: string | undefined }) {
  const status = STATUS_PILL[c.status];
  const last = c.last_message;
  const unread = c.unread_count > 0;
  const delivery = last?.direction === 'out' ? (DELIVERY[last.status] ?? DELIVERY['sent']) : null;
  const shown = c.tags.slice(0, 2);
  const more = c.tags.length - shown.length;
  return (
    <li>
      <Link
        to={`/inbox/${c.id}`}
        aria-current={active ? 'true' : undefined}
        aria-label={`${c.contact.name}${unread ? `, ${c.unread_count} sin leer` : ''}`}
        className={`grid gap-2.5 border-b border-line px-3 hover:bg-surface2 ${mobile ? 'min-h-[72px] grid-cols-[48px_minmax(0,1fr)] gap-3 py-3 active:bg-accent-soft' : 'grid-cols-[42px_minmax(0,1fr)] py-2.5'} ${active ? 'bg-accent-soft' : ''}`}
      >
        <Avatar name={c.contact.name} src={photo} size={mobile ? 48 : 42} className="self-start" />
        <span className="grid min-w-0 gap-0.5">
          <span className="flex items-baseline gap-2">
            <b className={`min-w-0 flex-1 truncate text-[14px] ${mobile && !unread ? 'font-semibold' : ''}`}>{c.contact.name}</b>
            <time dateTime={c.last_message_at ?? undefined} className={`shrink-0 text-[11px] ${unread ? 'font-semibold text-ok' : 'text-muted'}`}>{chatTime(c.last_message_at, now)}</time>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted">
            <span className={`min-w-0 flex-1 truncate ${unread && mobile ? 'font-semibold text-fg' : ''}`}>
              {delivery ? <span aria-label={`Tú: ${delivery.text}. `} title={delivery.text} className={`mr-1 ${last?.status === 'read' ? 'text-accent' : last?.status === 'failed' ? 'text-crit' : ''}`}>{delivery.mark}</span> : null}
              {last ? listPreview(last) : 'Sin mensajes'}
            </span>
            {unread ? <span aria-hidden="true" className="grid min-w-[19px] place-items-center rounded-full bg-ok px-1.5 text-[11px] font-bold text-white">{c.unread_count}</span> : null}
          </span>
          <span className={mobile ? 'mt-1 flex h-5 min-w-0 flex-nowrap items-center gap-1 overflow-hidden [&>*]:max-w-full [&>*]:truncate [&>*]:whitespace-nowrap [&>*]:leading-[18px]' : 'mt-1 flex flex-wrap items-center gap-1'}>
            {mobile ? null : <Pill kind={status.kind}>{status.label}</Pill>}
            <SlaPill sla={c.sla} now={now} hideDone />
            <ChannelMark kind={c.channel.kind} />
            {mobile ? null : c.queue ? <span className="rounded bg-surface2 px-1.5 py-0.5 text-[11px] font-semibold text-muted">{c.queue.name}</span> : null}
            {mobile ? null : c.owner ? <span className="rounded bg-surface2 px-1.5 py-0.5 text-[11px] font-semibold text-muted">{c.owner.name.split(' ')[0]}</span> : null}
            {c.my_access === 'collaborator_reply' || c.my_access === 'collaborator_view' ? <span className="rounded bg-info-soft px-1.5 py-0.5 text-[11px] font-semibold text-info" title="Te la compartieron: la ves como colaborador">Compartida</span> : null}
            {shown.map((t) => <TagBadge key={t.id} name={t.name} color={t.color} />)}
            {more > 0 ? <span className="rounded bg-surface2 px-1.5 py-0.5 text-[11px] font-semibold text-muted" title={c.tags.slice(2).map((t) => t.name).join(', ')}>+{more}</span> : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** Los filtros de la lista (los mismos en el panel de escritorio y en la hoja del móvil). */
/** Chip de acceso rápido del panel de filtros: activo en color de acento; `aria-pressed` para quien no ve el color. */
function QuickChip({ on, onClick, disabled = false, hint, children }: { on: boolean; onClick?: () => void; disabled?: boolean; hint?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={disabled ? undefined : on}
      disabled={disabled}
      title={hint}
      onClick={onClick}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-[12.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}
    >
      {children}
    </button>
  );
}

function FilterFields({ filters, set, opts, filtered, onClear, unreadCount }: { filters: InboxFilters; set: (patch: Partial<InboxFilters>) => void; opts: InboxOptions | undefined; filtered: number; onClear: () => void; unreadCount: number }) {
  return (
    <>
      <div role="group" aria-label="Accesos rápidos" className="flex flex-wrap items-center gap-2">
        <QuickChip on={filters.unread} onClick={() => set({ unread: !filters.unread })}>No leídas{unreadCount > 0 ? ` · ${unreadCount}` : ''}</QuickChip>
        <QuickChip on={filters.recent} onClick={() => set({ recent: !filters.recent })} hint="Las que tuvieron un mensaje en las últimas 24 horas">Recientes</QuickChip>
        <QuickChip on={false} disabled hint="Aún no está disponible">Destacadas <span className="text-[11px] font-normal">· Próximamente</span></QuickChip>
      </div>
      {opts && opts.owners.length > 0 ? (
        <label className="grid gap-1 text-[12px] font-semibold">Responsable
          <select aria-label="Responsable" value={filters.owner} onChange={(e) => set({ owner: e.target.value })} className={`${selectCls} font-normal`}>
            <option value="">Todos</option>
            {opts.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      ) : null}
      {opts && opts.queues.length > 0 ? (
        <label className="grid gap-1 text-[12px] font-semibold">Departamento
          <select aria-label="Departamento" value={filters.queue} onChange={(e) => set({ queue: e.target.value })} className={`${selectCls} font-normal`}>
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
      {filtered ? <Button variant="link" className="justify-self-start text-[12.5px]" onClick={onClear}>Limpiar filtros</Button> : null}
    </>
  );
}

/**
 * Columna izquierda del Inbox: búsqueda, filtros, pestañas con sus conteos y las conversaciones. Los filtros viven en la página (se conservan al abrir una
 * conversación). Se vuelve a consultar cada 10 s mientras la pestaña está a la vista.
 *
 * Móvil (ADR-60, Fase 4): cabecera compacta con el título «Inbox», el modo oscuro y los programados; buscador de 44 px y botón de filtros que abre una hoja inferior con los mismos
 * filtros; pestañas como segmento con desplazamiento horizontal y el atajo «No leídas» (el filtro ya existía); filas de al menos 72 px; esqueleto de carga. Al abrir una conversación
 * la lista sigue montada (oculta) y al volver recupera la posición de desplazamiento.
 */
export function ConversationList({ filters, onFilters, activeId, className = '' }: { filters: InboxFilters; onFilters: (f: InboxFilters) => void; activeId: string | undefined; className?: string }) {
  const q = useConversations(filters);
  const options = useInboxOptions();
  const nav = useContext(AppNavContext);
  const mobile = useBreakpoint() === 'mobile';
  const [search, setSearch] = useState(filters.q);
  const [panel, setPanel] = useState(false);
  const [sheet, setSheet] = useState(false);
  const loaded = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const photos = usePhotos(loaded.map((c) => c.contact.id), []);
  const counts = q.data?.pages[0]?.counts ?? null;
  const filtered = activeFilterCount(filters);
  // Las horas relativas («hace 5 min», «Vence en 2 min») se cuentan desde el último dato que llegó: así un listado recién consultado nunca muestra un cronómetro «de hace un minuto»
  const now = Math.max(useNow(60_000), q.dataUpdatedAt);
  // «Recientes»: las de las últimas 24 h por su último mensaje (el servidor no tiene este filtro: se aplica a lo ya cargado)
  const items = useMemo(() => (filters.recent ? loaded.filter((c) => c.last_message_at !== null && now - Date.parse(c.last_message_at) <= 24 * 3_600_000) : loaded), [loaded, filters.recent, now]);
  const set = (patch: Partial<InboxFilters>) => onFilters({ ...filters, ...patch });
  const clear = () => onFilters({ ...DEFAULT_INBOX_FILTERS, tab: filters.tab, q: filters.q });

  // La búsqueda espera a que se deje de escribir
  useEffect(() => {
    if (search === filters.q) return;
    const t = setTimeout(() => onFilters({ ...filters, q: search }), 300);
    return () => clearTimeout(t);
  }, [search, filters, onFilters]);

  // En móvil la lista se oculta (no se desmonta) mientras hay una conversación abierta; un contenedor oculto pierde su posición de desplazamiento en algunos navegadores:
  // se guarda al abrir una y se recupera al volver
  const scroller = useRef<HTMLDivElement>(null);
  const savedTop = useRef(0);
  const prevActive = useRef(activeId);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && prevActive.current !== undefined && activeId === undefined) el.scrollTop = savedTop.current;
    prevActive.current = activeId;
  }, [activeId]);

  const opts = options.data;
  const emptyText = filters.q || filtered ? 'No hay conversaciones con estos filtros.' : filters.tab === 'working' ? 'No tienes conversaciones en curso.' : filters.tab === 'pending' ? 'No hay conversaciones pendientes.' : 'Aún no hay conversaciones finalizadas.';

  const tabs = (
    <div role="tablist" aria-label="Estado de las conversaciones" className="flex overflow-x-auto [scrollbar-width:none]">
      {TABS.map((t) => (
        <button key={t.id} type="button" role="tab" title={t.hint} aria-selected={filters.tab === t.id} onClick={() => set({ tab: t.id })} className={`flex shrink-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-2 text-[13px] font-semibold ${mobile ? 'min-h-11' : 'py-2'} ${filters.tab === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}>
          {t.label}
          {counts ? <span className={`grid min-w-[18px] place-items-center rounded-full px-1.5 text-[11px] ${filters.tab === t.id ? 'bg-accent text-accent-ink' : 'bg-surface2 text-muted'}`}>{counts[t.id]}</span> : null}
        </button>
      ))}
    </div>
  );

  return (
    <section aria-label="Conversaciones" className={`flex min-h-0 min-w-0 flex-col border-line bg-surface md:border-r ${className}`}>
      {mobile ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 border-b border-line p-3 pb-0">
          <div className="flex items-center gap-2">
            <h1 className="flex-1 text-[18px] font-bold">Inbox</h1>
            <ThemeToggle touch />
            <Link to="/inbox/scheduled" aria-label="Mensajes programados de todas las conversaciones" title="Mensajes programados" className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface2 hover:text-fg">
              <Icon name="clock" />
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <input type="search" aria-label="Buscar conversaciones" placeholder="Buscar por nombre o teléfono" value={search} onChange={(e) => setSearch(e.target.value)} className="min-h-11 min-w-0 flex-1 rounded-full border border-transparent bg-surface2 px-4 text-[13px] placeholder:text-muted" />
            <button type="button" aria-haspopup="dialog" aria-label={filtered ? `Filtros (${filtered} activos)` : 'Filtros'} onClick={() => setSheet(true)} className={`relative grid size-11 shrink-0 place-items-center rounded-full border ${filtered ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>
              <Icon name="filter" />
              {filtered ? <span aria-hidden="true" className="absolute -right-1 -top-1 grid min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11px] font-bold leading-[18px] text-accent-ink">{filtered}</span> : null}
            </button>
          </div>
          {tabs}
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 border-b border-line p-3 pb-0">
          <div className="flex items-center gap-1">
            <h1 className="min-w-0 flex-1 truncate text-[16px] font-bold">Inbox</h1>
            {nav ? <ViewAsMenu me={nav.me} /> : null}
            <ThemeToggle />
            {nav ? <NotificationsBell me={nav.me} /> : null}
          </div>
          <div className="flex items-center gap-2">
            <input type="search" aria-label="Buscar conversaciones" placeholder="Buscar por nombre o teléfono" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-0 flex-1 rounded-full border border-transparent bg-surface2 px-3.5 py-2 text-[13px] placeholder:text-muted" />
            <Link to="/inbox/scheduled" aria-label="Mensajes programados de todas las conversaciones" title="Mensajes programados" className="grid size-9 shrink-0 place-items-center rounded-full border border-line text-muted hover:text-fg">
              <Icon name="clock" size={18} />
            </Link>
            <button type="button" aria-expanded={panel} aria-controls="inbox-filters" onClick={() => setPanel((p) => !p)} className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold ${panel || filtered ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>
              Filtros{filtered ? <span className="grid min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11px] text-accent-ink">{filtered}</span> : null}
            </button>
          </div>
          {panel ? (
            <div id="inbox-filters" className="grid gap-2 rounded-xl border border-line bg-bg p-2.5">
              <FilterFields filters={filters} set={set} opts={opts} filtered={filtered} onClear={clear} unreadCount={counts?.unread ?? 0} />
            </div>
          ) : null}
          {tabs}
        </div>
      )}
      <div ref={scroller} onScroll={(e) => { if (activeId === undefined) savedTop.current = e.currentTarget.scrollTop; }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {q.isPending ? (mobile ? <SkeletonRows label="Cargando conversaciones" /> : <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando conversaciones" /></div>) : null}
        {q.isError ? <div className="p-3"><Alert>{friendlyError(q.error, 'No pudimos cargar las conversaciones.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert></div> : null}
        {q.isSuccess && items.length === 0 ? (
          <div className="grid justify-items-center gap-2 p-8 text-center">
            <p className="text-[13px] text-muted">{emptyText}</p>
            {filtered || filters.q ? <Button variant="link" className="text-[12.5px]" onClick={() => { setSearch(''); onFilters({ ...DEFAULT_INBOX_FILTERS, tab: filters.tab }); }}>Quitar búsqueda y filtros</Button> : null}
          </div>
        ) : null}
        <ul>{items.map((c) => <Row key={c.id} c={c} active={c.id === activeId} now={now} mobile={mobile} photo={photos.contact(c.contact.id)} />)}</ul>
        {q.hasNextPage ? <div className="grid place-items-center p-3"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Cargar más</Button></div> : null}
      </div>
      {mobile && sheet ? (
        <Drawer label="Filtros" placement="bottom" onClose={() => setSheet(false)}>
          <div className="grid w-full gap-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[15px] font-bold">Filtros</h2>
              <button type="button" aria-label="Cerrar los filtros" onClick={() => setSheet(false)} className="grid size-11 place-items-center rounded-full text-muted hover:bg-surface2"><Icon name="close" /></button>
            </div>
            <FilterFields filters={filters} set={set} opts={opts} filtered={filtered} onClear={clear} unreadCount={counts?.unread ?? 0} />
            <Button variant="primary" block onClick={() => setSheet(false)}>Ver conversaciones</Button>
          </div>
        </Drawer>
      ) : null}
    </section>
  );
}
