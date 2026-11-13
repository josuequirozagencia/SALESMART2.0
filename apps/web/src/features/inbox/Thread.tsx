import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { timeLeft } from '../../lib/format';
import type { ChatMessage, Conversation } from '../../lib/types';
import { useNow } from '../../lib/useNow';
import { useBreakpoint } from '../../ui/breakpoints';
import { useChatBackground } from '../../ui/chatBackground';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Avatar } from '../../ui/Avatar';
import { Icon } from '../../ui/Icon';
import { DeleteConversationDialog } from './DeleteConversationDialog';
import { Pill } from '../../ui/Pill';
import { AppointmentDialog } from '../appointments/AppointmentDialog';
import { GhlFlowsDialog } from '../ghl/GhlFlowsPanel';
import { SaleDialog } from '../sales/SaleDialog';
import { usePhotos } from '../photos/usePhotos';
import { AgentSwitch } from './AgentBanner';
import { Composer } from './Composer';
import { ConversationTags, TagsPopoverButton } from './ConversationTags';
import { HeaderActionBar, type HeaderAction } from './HeaderActions';
import { ScheduledBubbles, useThreadScheduled } from './ScheduledBubbles';
import { SlaPill } from './SlaPill';
import { dayKey, dayLabel, personName, STATUS_PILL } from './inboxFormat';
import { MessageBubble } from './MessageBubble';
import { TransferDialog } from './TransferDialog';
import { useConversation, useConversationAction, useFavorite, useMarkRead, useMessages, useReact, useRetryMessage, useRevoke, useScheduledMessages } from './useInbox';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';

/** Aviso de la ventana de 24 h de WhatsApp oficial: cuánto queda para escribir libremente, o que ya pasó. */
function WindowNote({ c, onlyWarn = false }: { c: Conversation; onlyWarn?: boolean }) {
  const now = useNow(60_000);
  if (c.status === 'closed' || !c.can.reply || !c.window.expires_at) return null;
  const left = Date.parse(c.window.expires_at) - now;
  if (left <= 0) return <Pill kind="warn">Ventana de 24 h cerrada</Pill>;
  // En el chat móvil (v10b) solo se avisa cuando la ventana está por cerrarse: lo demás ocupaba una fila entera
  if (onlyWarn && left >= 3 * 3_600_000) return null;
  return <Pill kind={left < 3 * 3_600_000 ? 'warn' : 'muted'}>Puedes escribir libremente: quedan {timeLeft(left)}</Pill>;
}

/** Lo que la cabecera necesita de la distribución del Inbox (la maneja `InboxPage`; el hilo no sabe de columnas). */
export interface ThreadLayout {
  contactOpen: boolean;
  onToggleContact: () => void;
  /** El panel de contacto está pedido pero no cabe en esta ventana (escritorio): el botón se desactiva y lo explica. */
  contactBlocked?: boolean;
  /** Solo escritorio: la lista de conversaciones se puede plegar desde aquí. */
  listOpen?: boolean;
  onToggleList?: () => void;
  /** Solo escritorio: vuelve la distribución de columnas a sus anchos de origen. */
  onResetLayout?: () => void;
}

/** «Atrás» del chat móvil: vuelve a la pantalla anterior; si no la hay (se abrió desde un aviso o un enlace directo), a la lista. El enlace conserva su destino `/inbox`. */
function useGoBack(): (e: MouseEvent) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return (e) => {
    if (location.key !== 'default') {
      e.preventDefault();
      navigate(-1);
    }
  };
}

/** La estrella de la persona: «Destacar» / «Quitar de destacadas» (personal; nadie más la ve). */
export function FavoriteButton({ c }: { c: Conversation }) {
  const fav = useFavorite(c.id);
  return (
    <button
      type="button"
      aria-label={c.favorite ? 'Quitar de destacadas' : 'Destacar la conversación'}
      aria-pressed={c.favorite === true}
      title={c.favorite ? 'Quitar de tus destacadas' : 'Destacarla (solo tú ves tus estrellas)'}
      disabled={fav.isPending}
      onClick={() => fav.mutate(!c.favorite)}
      className={`grid size-11 place-items-center rounded-full border transition disabled:opacity-60 ${c.favorite ? 'border-warn bg-warn-soft text-warn' : 'border-transparent text-muted hover:bg-surface2 hover:text-fg'}`}
    >
      <Icon name="star" fill={c.favorite ? 'currentColor' : 'none'} />
    </button>
  );
}

function Header({ c, meId, onBackError, layout }: { c: Conversation; meId: string; onBackError: (m: string | undefined) => void; layout: ThreadLayout }) {
  const headPhotos = usePhotos([c.contact.id], []);
  const { contactOpen, onToggleContact, contactBlocked = false, listOpen, onToggleList, onResetLayout } = layout;
  const act = useConversationAction(c.id);
  const leave = useRevoke(c.id);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [sale, setSale] = useState(false);
  const [appointment, setAppointment] = useState(false);
  const [flows, setFlows] = useState(false);
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null);
  const now = useNow(30_000);
  const mobile = useBreakpoint() === 'mobile';
  const goBack = useGoBack();
  const scheduled = useScheduledMessages(c.id);
  const scheduledPending = (scheduled.data?.items ?? []).filter((m) => m.status === 'scheduled').length;
  const collaborator = c.my_access === 'collaborator_reply' || c.my_access === 'collaborator_view';
  const status = STATUS_PILL[c.status];
  // v13 S2.2: las acciones de la conversación son iconos de la cabecera (antes, el botón «Más ⋯»), las frecuentes primero; si no caben, un único «⋮» recoge las últimas. Aceptar y Asignarme siguen a la vista.
  // «Registrar venta», «Agendar» y el flujo de GoHighLevel los pide quien atiende la conversación (su dueño o quien ve todo), igual que en la ficha del contacto; el servidor vuelve a verificarlo
  const attends = c.owner !== null && (c.my_access === 'owner' || c.my_access === 'supervisor');
  const actions: HeaderAction[] = [];
  if (attends) actions.push({ id: 'sale', label: 'Registrar venta', icon: 'dollar', group: 1, onSelect: () => setSale(true) }, { id: 'appointment', label: 'Agendar', icon: 'calendar', group: 1, onSelect: () => setAppointment(true) });
  if (c.can.transfer || c.can.share) actions.push({ id: 'transfer', label: 'Transferir o compartir', icon: 'swap', group: 1, onSelect: () => setDialog(true) });
  if (c.can.close) actions.push({ id: 'close', label: 'Finalizar', icon: 'check', group: 1, danger: true, onSelect: () => setConfirm(true) });
  if (attends && c.channel.kind === 'ghl') actions.push({ id: 'flows', label: 'Inscribir en un flujo', icon: 'bolt', group: 2, onSelect: () => setFlows(true) });
  if (collaborator) actions.push({ id: 'leave', label: 'Dejar de participar', icon: 'logout', group: 2, onSelect: () => { onBackError(undefined); leave.mutate(meId, { onSuccess: () => navigate('/inbox'), onError: (e) => onBackError(friendlyError(e, 'No pudimos quitarte de la conversación.')) }); } });
  if (c.can.delete) actions.push({ id: 'delete', label: 'Eliminar conversación', icon: 'trash', group: 2, danger: true, onSelect: () => setDeleting(true) });
  const run = (a: 'accept' | 'take' | 'close', fallback: string) => {
    onBackError(undefined);
    act.mutate(a, { onSettled: () => setConfirm(false), onError: (e) => onBackError(friendlyError(e, fallback)) });
  };
  if (mobile) {
    // v10: una sola fila de acciones —volver, el bloque avatar+nombre (abre el panel del contacto), el chip QR, «Reanudar agente» (solo con el agente detenido) y el ⋮ (abre ese mismo panel)—;
    // el aviso amarillo del agente ya no ocupa el chat: su texto vive dentro del panel
    return (
      <header className="border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-1 px-1 py-1">
          <Link to="/inbox" onClick={goBack} aria-label="Volver a las conversaciones" className="grid size-11 shrink-0 place-items-center rounded-full text-fg hover:bg-surface2"><Icon name="back" size={22} /></Link>
          <button type="button" aria-haspopup="dialog" aria-label={`Ver los datos de ${c.contact.name}`} onClick={onToggleContact} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-1 text-left hover:bg-surface2">
            <Avatar name={c.contact.name} src={headPhotos.contact(c.contact.id)} size={40} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] font-bold">{c.contact.name}</span>
              <span className="block truncate text-[12.5px] text-muted" title={c.channel.name}>{c.contact.phone ?? 'Sin teléfono'} · {c.channel.kind === 'qr' ? 'QR' : c.channel.kind === 'ghl' ? 'GoHighLevel' : c.channel.name}{c.queue ? ` · ${c.queue.name}` : ''}</span>
            </span>
          </button>
          {/* v13 S1.2: el chip «QR» deja su lugar al icono de etiquetas; el canal sigue a la vista en el subtítulo */}
          <TagsPopoverButton c={c} />
          <AgentSwitch c={c} compact onError={onBackError} />
          <button type="button" aria-label="Más acciones" aria-haspopup="dialog" onClick={onToggleContact} className="relative grid size-11 shrink-0 place-items-center rounded-full text-fg hover:bg-surface2">
            <Icon name="more" size={22} strokeWidth={3.2} />
            {scheduledPending > 0 ? <span aria-hidden="true" className="absolute right-1 top-1 size-2.5 rounded-full bg-accent" /> : null}
          </button>
        </div>
        {c.channel.kind === 'qr' && c.channel.session === 'down' ? <p role="alert" className="mx-3 mb-2 rounded-lg border border-crit bg-crit-soft px-3 py-2 text-[12.5px] font-semibold text-crit">La sesión de WhatsApp por QR está caída. Lo que escribas queda en espera y sale cuando el administrador vuelva a escanear el QR en Configuración › Conexiones.</p> : null}
        {/* v10b: el estado y el cronómetro al día viven en el panel del contacto; aquí solo lo que pide acción (cronómetro en riesgo o vencido, ventana de 24 h por cerrar o cerrada). Sin nada, la fila no existe */}
        <div className="flex items-center gap-2 overflow-x-auto px-3 pb-2 [scrollbar-width:none] empty:hidden">
          {c.sla && (c.sla.state === 'late' || c.sla.state === 'risk') ? <SlaPill sla={c.sla} now={now} /> : null}
          <WindowNote c={c} onlyWarn />
        </div>
      </header>
    );
  }
  return (
    <header className="grid grid-cols-[minmax(0,1fr)] gap-2 border-b border-line bg-surface px-3 py-2.5">
      <div ref={setRowEl} className="flex items-center gap-2.5">
        <Link to="/inbox" aria-label="Volver a las conversaciones" className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface2 md:hidden">←</Link>
        <Avatar name={c.contact.name} src={headPhotos.contact(c.contact.id)} size={40} />
        <div data-flex="" className="min-w-0 flex-1">
          <h2 onClick={onToggleContact} title="Ver los datos del contacto" className="cursor-pointer truncate text-[15px] font-bold hover:underline">{c.contact.name}</h2>
          <p className="truncate text-[12.5px] text-muted">{c.contact.phone ?? 'Sin teléfono'} · {c.channel.name}{c.queue ? ` · ${c.queue.name}` : ''}{c.channel.kind === 'qr' ? <span className="ml-1.5 rounded-full border border-warn bg-warn-soft px-1.5 py-px text-[10.5px] font-semibold text-warn">QR</span> : null}</p>
        </div>
        <HeaderActionBar actions={actions} row={rowEl} />
        <div className="flex shrink-0 items-center gap-1">
          {onToggleList ? (
            <button
              type="button"
              aria-label="Lista de conversaciones"
              aria-pressed={listOpen === true}
              title={listOpen ? 'Ocultar la lista de conversaciones' : 'Mostrar la lista de conversaciones'}
              onClick={onToggleList}
              className={`grid size-11 place-items-center rounded-full border transition ${listOpen ? 'border-accent bg-accent-soft text-accent' : 'border-transparent text-muted hover:bg-surface2 hover:text-fg'}`}
            >
              <Icon name="list" />
            </button>
          ) : null}
          {onResetLayout ? (
            <button type="button" aria-label="Restaurar distribución" title="Restaurar la distribución de las columnas" onClick={onResetLayout} className="grid size-11 place-items-center rounded-full border border-transparent text-muted transition hover:bg-surface2 hover:text-fg">
              <Icon name="reset" />
            </button>
          ) : null}
          <AgentSwitch c={c} onError={onBackError} />
          <FavoriteButton c={c} />
          <button
            type="button"
            aria-label="Datos del contacto"
            aria-pressed={contactOpen}
            disabled={contactBlocked}
            title={contactBlocked ? 'No hay espacio para los datos del contacto: ensancha la ventana, pliega el menú lateral o la lista' : contactOpen ? 'Ocultar los datos del contacto' : 'Ver los datos del contacto'}
            onClick={onToggleContact}
            className={`grid size-11 place-items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${contactOpen ? 'border-accent bg-accent-soft text-accent' : 'border-transparent text-muted hover:bg-surface2 hover:text-fg'}`}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18v14H3z" /><path d="M12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" /><path d="M8 16a4 4 0 0 1 8 0" /></svg>
          </button>
        </div>
      </div>
      {c.channel.kind === 'qr' && c.channel.session === 'down' ? <p role="alert" className="w-full rounded-lg border border-crit bg-crit-soft px-3 py-2 text-[12.5px] font-semibold text-crit">La sesión de WhatsApp por QR está caída. Lo que escribas queda en espera y sale cuando el administrador vuelva a escanear el QR en Configuración › Conexiones.</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Pill kind={status.kind}>{status.label}</Pill>
        <SlaPill sla={c.sla} now={now} />
        <span className="text-[12.5px] text-muted">{c.owner ? `Asignada a ${personName(c.owner.name)}` : 'Sin asesor'}</span>
        {c.participants.length > 0 ? <span className="text-[12.5px] text-muted" title={c.participants.map((p) => `${personName(p.user.name)}: ${p.permission === 'reply' ? 'puede responder' : 'solo ver y dejar notas'}`).join('\n')}>Compartida con {c.participants.map((p) => personName(p.user.name).split(' ')[0]).join(', ')}</span> : null}
        <ConversationTags c={c} />
        <WindowNote c={c} />
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        {confirm ? (
          <span className="flex flex-wrap items-center gap-2 text-[12.5px]">
            ¿Finalizar? Si el cliente escribe de nuevo se abrirá otra conversación.
            <Button variant="danger" className={SMALL} loading={act.isPending} onClick={() => run('close', 'No pudimos finalizar la conversación.')}>Sí, finalizar</Button>
            <Button className={SMALL} onClick={() => setConfirm(false)}>No</Button>
          </span>
        ) : (
          <>
            {c.can.accept ? <Button variant="primary" className={SMALL} loading={act.isPending} onClick={() => run('accept', 'No pudimos aceptar la conversación.')}>Aceptar</Button> : null}
            {c.can.take ? <Button variant="primary" className={SMALL} loading={act.isPending} onClick={() => run('take', 'No pudimos asignarte la conversación.')}>Asignarme</Button> : null}
          </>
        )}
        </div>
        {deleting ? <DeleteConversationDialog c={c} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); navigate('/inbox'); }} /> : null}
        {dialog ? <TransferDialog c={c} onClose={() => setDialog(false)} onTransferred={(r) => { setDialog(false); if (!r.still_visible) navigate('/inbox'); }} /> : null}
        {sale ? <SaleDialog c={c} onClose={() => setSale(false)} /> : null}
        {appointment ? <AppointmentDialog c={c} onClose={() => setAppointment(false)} /> : null}
        {flows ? <GhlFlowsDialog contact={c.contact} onClose={() => setFlows(false)} /> : null}
      </div>
    </header>
  );
}

/** Mensajes del hilo agrupados por día, con la carga de los más antiguos arriba. */
/** Quién habla, para agrupar los mensajes seguidos de la misma persona (las notas internas no cuentan y cortan el grupo). */
function senderKey(m: ChatMessage): string {
  if (m.is_note) return 'note';
  if (m.direction === 'in') return 'contact';
  if (m.sender_type === 'ai') return 'ai';
  if (m.sender_type === 'automation') return 'automation';
  return m.author ? `u:${m.author.id}` : 'out';
}

/** El avatar de un mensaje: solo en el primero de cada grupo (los demás reservan el espacio); la foto si existe y, si no, las siglas. El agente y los avisos automáticos llevan un icono propio, nunca una foto. */
function avatarFor(m: ChatMessage, first: boolean, contactName: string, photos: { contact: (id: string) => string | undefined; user: (id: string) => string | undefined }, contactId = ''): ReactNode {
  if (!first) return null;
  if (m.direction === 'in') return <Avatar name={contactName} src={photos.contact(contactId)} size={28} />;
  if (m.sender_type === 'ai') return <span aria-hidden="true" className="grid size-7 place-items-center rounded-full bg-accent text-[10px] font-bold text-accent-ink">IA</span>;
  if (m.sender_type === 'automation') return <span aria-hidden="true" className="grid size-7 place-items-center rounded-full bg-surface2 text-muted"><Icon name="clock" size={14} /></span>;
  // Lo que se escribió en el teléfono de la línea no tiene autor conocido: un icono de teléfono, igual de discreto que el de los avisos automáticos (v10)
  if (!m.author && m.extra?.['origin'] === 'device') return <span aria-hidden="true" title="Desde el teléfono" className="grid size-7 place-items-center rounded-full bg-surface2 text-muted"><Icon name="phone" size={14} /></span>;
  return <Avatar name={personName(m.author?.name)} src={m.author ? photos.user(m.author.id) : undefined} size={28} tone="accent" />;
}

function Messages({ c }: { c: Conversation }) {
  const q = useMessages(c.id);
  const retry = useRetryMessage(c.id);
  const reactMut = useReact(c.id);
  const [retryError, setRetryError] = useState<string>();
  // Reaccionar: solo WhatsApp oficial, dentro de la ventana de 24 h y quien puede responder (el servidor lo vuelve a verificar)
  const canReact = c.can.reply && c.window.open && (c.channel.kind ?? 'whatsapp') === 'whatsapp';
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Mensajes que llegaron mientras la persona leía lo anterior (más arriba del final): se ofrece bajar con un botón en vez de saltar
  const [newCount, setNewCount] = useState(0);
  const counted = useRef(0);
  const lastSeen = useRef<string | undefined>(undefined);
  // Las páginas vienen de la más reciente a la más antigua; cada una, de antigua a reciente
  const items = useMemo<ChatMessage[]>(() => [...(q.data?.pages ?? [])].reverse().flatMap((p) => p.items), [q.data]);
  const authorIds = useMemo(() => items.flatMap((m) => (m.author && m.direction === 'out' && !m.is_note ? [m.author.id] : [])), [items]);
  const photos = usePhotos([c.contact.id], authorIds);
  const last = items[items.length - 1]?.id;
  // v13 S2.4: los mensajes programados se ven al final del hilo, con su hora y sus acciones
  const scheduled = useThreadScheduled(c.id);

  // Se queda al final mientras la persona no haya subido a leer lo anterior
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [last, items.length, scheduled.items.length]);
  useEffect(() => {
    const added = items.length - counted.current;
    const hadSome = counted.current > 0;
    counted.current = items.length;
    const newest = items[items.length - 1]?.id;
    const arrivedAtEnd = newest !== lastSeen.current;
    lastSeen.current = newest;
    // Solo cuenta lo que llega al final (no la primera carga ni los mensajes antiguos que se piden arriba) y solo si no se está viendo el final
    if (added > 0 && hadSome && arrivedAtEnd && !stick.current) setNewCount((n) => n + added);
  }, [items]);
  const toBottom = (): void => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setNewCount(0);
  };

  const now = useNow(60_000);
  const chatBg = useChatBackground();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div
      ref={box}
      role="log"
      aria-label="Mensajes"
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (stick.current) setNewCount((n) => (n === 0 ? n : 0));
      }}
      style={chatBg.style}
      className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 md:px-4 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden ${chatBg.className}`}
    >
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando mensajes" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los mensajes.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.hasNextPage ? <div className="grid place-items-center pb-3"><Button className={SMALL} loading={q.isFetchingNextPage} onClick={() => { stick.current = false; void q.fetchNextPage(); }}>Cargar mensajes anteriores</Button></div> : null}
      {q.isSuccess && items.length === 0 ? <p className="py-10 text-center text-[13px] text-muted">Todavía no hay mensajes en esta conversación.</p> : null}
      {retryError ? <div className="pb-2"><Alert>{retryError}</Alert></div> : null}
      <ul className="grid">
        {items.map((m, i) => (
          <Fragment key={m.id}>
            {i === 0 || dayKey(items[i - 1]!.sent_at) !== dayKey(m.sent_at) ? <li className="sticky top-1 z-[1] my-1 text-center"><span className="rounded-full bg-surface2 px-3 py-0.5 shadow-sm text-[11.5px] font-semibold text-muted">{dayLabel(m.sent_at, now)}</span></li> : null}
            <MessageBubble
              m={m}
              spacing={i === 0 ? '' : senderKey(items[i - 1]!) !== senderKey(m) || dayKey(items[i - 1]!.sent_at) !== dayKey(m.sent_at) ? 'mt-2.5' : 'mt-1'}
              avatar={m.is_note ? undefined : avatarFor(m, i === 0 || senderKey(items[i - 1]!) !== senderKey(m) || dayKey(items[i - 1]!.sent_at) !== dayKey(m.sent_at), c.contact.name, photos, c.contact.id)}
              canRetry={c.can.reply}
              retrying={retry.isPending && retry.variables === m.id}
              onRetry={(id) => { setRetryError(undefined); retry.mutate(id, { onError: (e) => setRetryError(friendlyError(e, 'No pudimos reintentar el envío.')) }); }}
              onReact={canReact ? (id, emoji) => { setRetryError(undefined); reactMut.mutate({ messageId: id, emoji }, { onError: (e) => setRetryError(friendlyError(e, 'No pudimos enviar la reacción.')) }); } : undefined}
            />
          </Fragment>
        ))}
      </ul>
      <ScheduledBubbles c={c} items={scheduled.items} timeZone={scheduled.timeZone} />
    </div>
    {newCount > 0 ? (
      <button type="button" onClick={toBottom} className="absolute bottom-3 right-3 z-[2] inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-semibold text-accent-ink shadow-[var(--shadow)]">
        <Icon name="arrowDown" size={16} />
        {newCount === 1 ? '1 mensaje nuevo' : `${newCount} mensajes nuevos`}
      </button>
    ) : null}
    </div>
  );
}

/**
 * El hilo de UNA conversación: cabecera con su estado y acciones (aceptar, asignarme, finalizar), los mensajes y el redactor. Se actualiza cada 5 s. Al abrirla,
 * si la persona es su dueña, se marca como leída.
 */
export function Thread({ id, meId, layout }: { id: string; meId: string; layout: ThreadLayout }) {
  const q = useConversation(id);
  const { mutate: markRead } = useMarkRead(id);
  const tried = useRef('');
  const [actionError, setActionError] = useState<string>();
  const c = q.data;
  const unread = c && c.owner?.id === meId ? c.unread_count : 0;

  // Marca como leída al abrirla y cada vez que llegan mensajes nuevos con ella abierta (una vez por cantidad de no leídos: si falla, no se insiste en bucle)
  useEffect(() => {
    const key = `${id}:${unread}`;
    if (unread === 0 || tried.current === key) return;
    tried.current = key;
    markRead();
  }, [unread, id, markRead]);

  if (q.isPending) return <section aria-label="Conversación" className="grid min-w-0 flex-1 place-items-center text-muted"><Spinner label="Cargando conversación" /></section>;
  if (q.isError || !c) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return (
      <section aria-label="Conversación" className="grid min-w-0 flex-1 place-content-center gap-3 p-8 text-center">
        <p className="text-[14px] text-muted">{gone ? 'Esa conversación no existe o no tienes acceso a ella.' : friendlyError(q.error, 'No pudimos cargar la conversación.')}</p>
        <div className="flex justify-center gap-2">
          {gone ? null : <Button onClick={() => void q.refetch()}>Reintentar</Button>}
          <Link to="/inbox" className="inline-flex items-center rounded-[10px] border border-line px-4 py-3 text-[14px] font-semibold hover:bg-surface2">Ver conversaciones</Link>
        </div>
      </section>
    );
  }
  return (
    <section aria-label={`Conversación con ${c.contact.name}`} className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <Header c={c} meId={meId} onBackError={setActionError} layout={layout} />
      {actionError ? <div className="px-3 pt-2"><Alert>{actionError}</Alert></div> : null}
      <Messages c={c} />
      <Composer key={c.id} c={c} />
    </section>
  );
}
