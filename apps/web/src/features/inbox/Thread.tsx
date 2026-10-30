import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { initials, timeLeft } from '../../lib/format';
import type { ChatMessage, Conversation } from '../../lib/types';
import { useNow } from '../../lib/useNow';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { GhlFlowsDialog } from '../ghl/GhlFlowsPanel';
import { AppointmentDialog } from '../appointments/AppointmentDialog';
import { SaleDialog } from '../sales/SaleDialog';
import { AgentBanner } from './AgentBanner';
import { Composer } from './Composer';
import { ContactSidebar } from './ContactSidebar';
import { ConversationTags } from './ConversationTags';
import { SlaPill } from './SlaPill';
import { dayKey, dayLabel, STATUS_PILL } from './inboxFormat';
import { MessageBubble } from './MessageBubble';
import { TransferDialog } from './TransferDialog';
import { useConversation, useConversationAction, useMarkRead, useMessages, useReact, useRetryMessage, useRevoke } from './useInbox';

const SMALL = '!px-3 !py-1.5 !text-[12.5px]';

/** Aviso de la ventana de 24 h de WhatsApp oficial: cuánto queda para escribir libremente, o que ya pasó. */
function WindowNote({ c }: { c: Conversation }) {
  const now = useNow(60_000);
  if (c.status === 'closed' || !c.can.reply || !c.window.expires_at) return null;
  const left = Date.parse(c.window.expires_at) - now;
  if (left <= 0) return <Pill kind="warn">Ventana de 24 h cerrada</Pill>;
  return <Pill kind={left < 3 * 3_600_000 ? 'warn' : 'muted'}>Puedes escribir libremente: quedan {timeLeft(left)}</Pill>;
}

function Header({ c, meId, onBackError, contactOpen, onToggleContact }: { c: Conversation; meId: string; onBackError: (m: string | undefined) => void; contactOpen: boolean; onToggleContact: () => void }) {
  const act = useConversationAction(c.id);
  const leave = useRevoke(c.id);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [sale, setSale] = useState(false);
  const [appointment, setAppointment] = useState(false);
  const [flows, setFlows] = useState(false);
  const now = useNow(30_000);
  const collaborator = c.my_access === 'collaborator_reply' || c.my_access === 'collaborator_view';
  const status = STATUS_PILL[c.status];
  const run = (a: 'accept' | 'take' | 'close', fallback: string) => {
    onBackError(undefined);
    act.mutate(a, { onSettled: () => setConfirm(false), onError: (e) => onBackError(friendlyError(e, fallback)) });
  };
  return (
    <header className="grid grid-cols-[minmax(0,1fr)] gap-2 border-b border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <Link to="/inbox" aria-label="Volver a las conversaciones" className="grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-surface2 lg:hidden">←</Link>
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-surface2 text-[13px] font-bold text-muted">{initials(c.contact.name)}</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-bold"><button type="button" onClick={onToggleContact} aria-expanded={contactOpen} aria-label={`Datos de ${c.contact.name}`} className="max-w-full truncate rounded text-left hover:underline">{c.contact.name}</button></h2>
          <p className="truncate text-[12.5px] text-muted">{c.contact.phone ?? 'Sin teléfono'} · {c.channel.name}{c.queue ? ` · ${c.queue.name}` : ''}{c.channel.kind === 'qr' ? <span className="ml-1.5 rounded-full border border-warn bg-warn-soft px-1.5 py-px text-[10.5px] font-semibold text-warn">QR · no oficial</span> : null}</p>
        </div>
      </div>
      {c.channel.kind === 'qr' && c.channel.session === 'down' ? <p role="alert" className="w-full rounded-lg border border-crit bg-crit-soft px-3 py-2 text-[12.5px] font-semibold text-crit">La sesión de WhatsApp por QR está caída. Lo que escribas queda en espera y sale cuando el administrador vuelva a escanear el QR en Configuración › Conexiones.</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Pill kind={status.kind}>{status.label}</Pill>
        <SlaPill sla={c.sla} now={now} />
        <span className="text-[12.5px] text-muted">{c.owner ? `Asignada a ${c.owner.name}` : 'Sin asesor'}</span>
        {c.participants.length > 0 ? <span className="text-[12.5px] text-muted" title={c.participants.map((p) => `${p.user.name}: ${p.permission === 'reply' ? 'puede responder' : 'solo ver y dejar notas'}`).join('\n')}>Compartida con {c.participants.map((p) => p.user.name.split(' ')[0]).join(', ')}</span> : null}
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
            {c.can.transfer || c.can.share ? <Button className={SMALL} onClick={() => setDialog(true)}>Transferir</Button> : null}
            {collaborator ? <Button className={SMALL} loading={leave.isPending} onClick={() => { onBackError(undefined); leave.mutate(meId, { onSuccess: () => navigate('/inbox'), onError: (e) => onBackError(friendlyError(e, 'No pudimos quitarte de la conversación.')) }); }}>Dejar de participar</Button> : null}
            {c.owner && (c.my_access === 'owner' || c.my_access === 'supervisor') ? <Button className={SMALL} onClick={() => setAppointment(true)}>Agendar</Button> : null}
            {c.owner && (c.my_access === 'owner' || c.my_access === 'supervisor') ? <Button className={SMALL} onClick={() => setSale(true)}>Registrar venta</Button> : null}
            {c.channel.kind === 'ghl' && c.owner && (c.my_access === 'owner' || c.my_access === 'supervisor') ? <Button className={SMALL} onClick={() => setFlows(true)}>Inscribir en un flujo</Button> : null}
            <Button className={SMALL} aria-pressed={contactOpen} onClick={onToggleContact}>{contactOpen ? 'Ocultar datos' : 'Datos del contacto'}</Button>
            {c.can.close ? <Button className={SMALL} onClick={() => setConfirm(true)}>Finalizar</Button> : null}
          </>
        )}
        </div>
        {appointment ? <AppointmentDialog c={c} onClose={() => setAppointment(false)} /> : null}
        {flows ? <GhlFlowsDialog contact={c.contact} onClose={() => setFlows(false)} /> : null}
        {sale ? <SaleDialog c={c} onClose={() => setSale(false)} /> : null}
        {dialog ? <TransferDialog c={c} onClose={() => setDialog(false)} onTransferred={(r) => { setDialog(false); if (!r.still_visible) navigate('/inbox'); }} /> : null}
      </div>
    </header>
  );
}

/** Mensajes del hilo agrupados por día, con la carga de los más antiguos arriba. */
function Messages({ c }: { c: Conversation }) {
  const q = useMessages(c.id);
  const retry = useRetryMessage(c.id);
  const reactMut = useReact(c.id);
  const [retryError, setRetryError] = useState<string>();
  // Reaccionar: solo WhatsApp oficial, dentro de la ventana de 24 h y quien puede responder (el servidor lo vuelve a verificar)
  const canReact = c.can.reply && c.window.open && (c.channel.kind ?? 'whatsapp') === 'whatsapp';
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Las páginas vienen de la más reciente a la más antigua; cada una, de antigua a reciente
  const items = useMemo<ChatMessage[]>(() => [...(q.data?.pages ?? [])].reverse().flatMap((p) => p.items), [q.data]);
  const last = items[items.length - 1]?.id;

  // Se queda al final mientras la persona no haya subido a leer lo anterior
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [last, items.length]);

  const now = useNow(60_000);
  return (
    <div
      ref={box}
      role="log"
      aria-label="Mensajes"
      aria-live="polite"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
      className="min-h-0 flex-1 overflow-y-auto bg-bg px-[4%] py-3"
    >
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando mensajes" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los mensajes.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.hasNextPage ? <div className="grid place-items-center pb-3"><Button className={SMALL} loading={q.isFetchingNextPage} onClick={() => { stick.current = false; void q.fetchNextPage(); }}>Cargar mensajes anteriores</Button></div> : null}
      {q.isSuccess && items.length === 0 ? <p className="py-10 text-center text-[13px] text-muted">Todavía no hay mensajes en esta conversación.</p> : null}
      {retryError ? <div className="pb-2"><Alert>{retryError}</Alert></div> : null}
      <ul className="grid gap-1.5">
        {items.map((m, i) => (
          <Fragment key={m.id}>
            {i === 0 || dayKey(items[i - 1]!.sent_at) !== dayKey(m.sent_at) ? <li className="my-1 text-center"><span className="rounded-full bg-surface2 px-3 py-0.5 text-[11.5px] font-semibold text-muted">{dayLabel(m.sent_at, now)}</span></li> : null}
            <MessageBubble
              m={m}
              canRetry={c.can.reply}
              retrying={retry.isPending && retry.variables === m.id}
              onRetry={(id) => { setRetryError(undefined); retry.mutate(id, { onError: (e) => setRetryError(friendlyError(e, 'No pudimos reintentar el envío.')) }); }}
              onReact={canReact ? (id, emoji) => { setRetryError(undefined); reactMut.mutate({ messageId: id, emoji }, { onError: (e) => setRetryError(friendlyError(e, 'No pudimos enviar la reacción.')) }); } : undefined}
            />
          </Fragment>
        ))}
      </ul>
    </div>
  );
}

/**
 * El hilo de UNA conversación: cabecera con su estado y acciones (aceptar, asignarme, finalizar), los mensajes y el redactor. Se actualiza cada 5 s. Al abrirla,
 * si la persona es su dueña, se marca como leída.
 */
export function Thread({ id, meId }: { id: string; meId: string }) {
  const q = useConversation(id);
  const { mutate: markRead } = useMarkRead(id);
  const tried = useRef('');
  const [actionError, setActionError] = useState<string>();
  const [contactOpen, setContactOpen] = useState(false);
  const c = q.data;
  const unread = c && c.owner?.id === meId ? c.unread_count : 0;

  // Marca como leída al abrirla y cada vez que llegan mensajes nuevos con ella abierta (una vez por cantidad de no leídos: si falla, no se insiste en bucle)
  useEffect(() => {
    const key = `${id}:${unread}`;
    if (unread === 0 || tried.current === key) return;
    tried.current = key;
    markRead();
  }, [unread, id, markRead]);

  if (q.isPending) return <section aria-label="Conversación" className="grid place-items-center text-muted"><Spinner label="Cargando conversación" /></section>;
  if (q.isError || !c) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return (
      <section aria-label="Conversación" className="grid place-content-center gap-3 p-8 text-center">
        <p className="text-[14px] text-muted">{gone ? 'Esa conversación no existe o no tienes acceso a ella.' : friendlyError(q.error, 'No pudimos cargar la conversación.')}</p>
        <div className="flex justify-center gap-2">
          {gone ? null : <Button onClick={() => void q.refetch()}>Reintentar</Button>}
          <Link to="/inbox" className="inline-flex items-center rounded-[10px] border border-line px-4 py-3 text-[14px] font-semibold hover:bg-surface2">Ver conversaciones</Link>
        </div>
      </section>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0">
      <section aria-label={`Conversación con ${c.contact.name}`} className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
        <Header c={c} meId={meId} onBackError={setActionError} contactOpen={contactOpen} onToggleContact={() => setContactOpen((v) => !v)} />
        {actionError ? <div className="px-3 pt-2"><Alert>{actionError}</Alert></div> : null}
        <AgentBanner c={c} />
        <Messages c={c} />
        <Composer key={c.id} c={c} />
      </section>
      {contactOpen ? (
        // En pantallas de hasta 1180 px la columna se abre como panel sobre el hilo; más anchas, queda al lado
        <div className="fixed inset-y-0 right-0 z-40 flex w-[min(380px,100%)] shadow-[var(--shadow)] min-[1181px]:static min-[1181px]:z-auto min-[1181px]:w-[340px] min-[1181px]:shrink-0 min-[1181px]:shadow-none">
          <ContactSidebar c={c} onClose={() => setContactOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
