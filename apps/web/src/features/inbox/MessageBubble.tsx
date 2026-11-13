import { useState, type ReactNode } from 'react';
import { useBreakpoint } from '../../ui/breakpoints';
import { Drawer } from '../../ui/Drawer';
import { Icon } from '../../ui/Icon';
import type { ChatMessage } from '../../lib/types';
import { Button } from '../../ui/controls';
import { QUICK_REACTIONS } from './emoji';
import { fileSize } from '../../lib/format';
import { attachmentTypeLabel, bubbleTime, describeExtra, firstName, kindLabel, personName } from './inboxFormat';
import { useSwipeReply } from './useSwipeReply';
import type { ReplyQuote } from '../../lib/types';
import { splitMentions } from './mentions';
import { LocationCard } from './LocationCard';
import { validPlace, type Place } from '../../lib/osm';

const TICK: Record<string, { text: string; label: string; cls: string }> = {
  queued: { text: '◷', label: 'Enviando', cls: 'opacity-60' },
  sent: { text: '✓', label: 'Enviado', cls: 'opacity-60' },
  delivered: { text: '✓✓', label: 'Entregado', cls: 'opacity-60' },
  read: { text: '✓✓', label: 'Leído', cls: 'text-info opacity-100' },
  failed: { text: '!', label: 'No se pudo enviar', cls: 'text-crit font-bold opacity-100' },
};

/** Sobre el degradado (`onGrad`) el color no puede distinguir «leído» de «entregado» (el azul no tiene contraste): se distingue por el peso y la transparencia suave de los gráficos (≥ 3:1). */
const TICK_ON_GRAD: Record<string, string> = { queued: 'opacity-75', sent: 'opacity-75', delivered: 'opacity-75', read: 'font-black', failed: 'font-black underline' };

function Ticks({ status, onGrad = false }: { status: ChatMessage['status']; onGrad?: boolean }) {
  const t = TICK[status];
  return t ? <span role="img" aria-label={t.label} title={t.label} className={`ml-1 tracking-[-0.34em] ${onGrad ? (TICK_ON_GRAD[status] ?? '') : t.cls}`}>{t.text}</span> : null;
}

/** Una imagen del hilo. En móvil se toca para verla ampliada a pantalla completa (con botón de cerrar); en escritorio es un enlace a otra pestaña, como siempre. */
function ChatImage({ url, name }: { url: string; name: string }) {
  const mobile = useBreakpoint() === 'mobile';
  const [open, setOpen] = useState(false);
  if (!mobile) return <a href={url} target="_blank" rel="noopener noreferrer" className="mt-1 block"><img src={url} alt={name} className="h-auto max-w-full rounded-lg" loading="lazy" /></a>;
  return (
    <>
      <button type="button" aria-label="Ver la imagen ampliada" onClick={() => setOpen(true)} className="mt-1 block max-w-full"><img src={url} alt={name} className="h-auto max-w-full rounded-lg" loading="lazy" /></button>
      {open ? (
        <Drawer label="Imagen ampliada" placement="full" onClose={() => setOpen(false)}>
          <div className="relative grid h-full w-full place-items-center bg-black">
            <img src={url} alt={name} className="max-h-full max-w-full object-contain" />
            <button type="button" aria-label="Cerrar la imagen" onClick={() => setOpen(false)} className="absolute right-3 top-3 grid size-11 place-items-center rounded-full bg-white/20 text-white"><Icon name="close" /></button>
          </div>
        </Drawer>
      ) : null}
    </>
  );
}

/** Tipos de mensaje con archivo: su tipo se muestra en la tarjeta o el reproductor, nunca el nombre del archivo. */
const FILE_KINDS: ReadonlySet<string> = new Set(['image', 'audio', 'video', 'document']);

/** Tarjeta de un documento: ícono, el TIPO como título y el tamaño debajo (como WhatsApp). El nombre del archivo no se muestra; solo viaja en el atributo de descarga. */
function DocumentCard({ url, mime, size, filename }: { url: string; mime: string | null; size: number | null; filename: string | null }) {
  const type = attachmentTypeLabel(mime);
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" download={filename ?? undefined} aria-label={`Descargar ${type}${size !== null ? `, ${fileSize(size)}` : ''}`} className="mt-1 flex min-h-11 items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-2 no-underline">
      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-md bg-accent-soft text-[11px] font-bold text-accent">{type.slice(0, 4)}</span>
      <span className="min-w-0"><b className="block truncate text-[13px] text-fg">{type}</b>{size !== null ? <span className="block text-[12px] text-muted">{fileSize(size)}</span> : null}</span>
    </a>
  );
}

/** El contenido: texto, o el nombre del tipo de contenido cuando no hay texto (los archivos aún no se descargan: llega en M5.6). */
function Body({ m }: { m: ChatMessage }) {
  // v13 S3.2: una ubicación con coordenadas válidas se ve como un mapa con pin (y su nombre y dirección); sin ellas, solo el rótulo «Ubicación»
  const where = m.kind === 'location' ? (m.extra?.['location'] ?? null) : null;
  const w = validPlace(where) ? (where as Place & { name?: unknown; address?: unknown }) : null;
  const card = w ? { place: w, name: typeof w.name === 'string' ? w.name : null, address: typeof w.address === 'string' ? w.address : null } : null;
  const extra = card ? null : describeExtra(m);
  const isText = m.kind === 'text' || m.kind === 'note' || m.kind === 'template';
  const att = m.attachment;
  return (
    <>
      {card ? <LocationCard place={card.place} name={card.name} address={card.address} /> : null}
      {!isText && !card && (!FILE_KINDS.has(m.kind) || !att?.url) ? <span className="mb-0.5 block text-[12px] font-semibold opacity-80">{kindLabel(m.kind)}</span> : null}
      {m.text ? <span className="block whitespace-pre-wrap break-words">{m.is_note && m.mentions && m.mentions.length > 0 ? splitMentions(m.text, m.mentions).map((p, i) => (p.mention ? <mark key={i} className="rounded bg-accent-soft px-0.5 font-semibold text-accent">{p.text}</mark> : <span key={i}>{p.text}</span>)) : m.text}</span> : null}
      {extra ? <span className="block text-[12.5px] opacity-80">{extra}</span> : null}
      {att ? (
        att.scan_status === 'infected' ? <span className="mt-0.5 block text-[12px] font-semibold text-crit">El antivirus bloqueó este archivo{att.error ? `: ${att.error}` : ''}</span>
        : att.scan_status === 'pending' ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo se está revisando…</span>
        : att.url ? (
          att.mime_type?.startsWith('image/') ? <ChatImage url={att.url} name="Imagen" />
          : att.mime_type?.startsWith('video/') ? <><span className="mb-0.5 block text-[12px] font-semibold opacity-80">Video</span><video src={att.url} controls className="max-w-full rounded-lg" /></>
          : att.mime_type?.startsWith('audio/') ? <><span className="mb-0.5 block text-[12px] font-semibold opacity-80">Audio</span><audio src={att.url} controls className="w-full max-w-full" /></>
          : <DocumentCard url={att.url} mime={att.mime_type} size={att.size_bytes} filename={att.filename} />
        ) : att.scan_status === 'skipped' && m.kind !== 'text' ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo aún no se puede ver aquí · sin revisar</span>
        : m.media ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo aún no se puede ver aquí.</span> : null
      ) : m.media ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo aún no se puede ver aquí.</span> : null}
    </>
  );
}

/**
 * Menú de reacciones de un mensaje del cliente (M5.8): las seis habituales y, si ya reaccionamos, quitarla. Es un grupo de botones (no un menú de flechas), así que Tab llega a cada
 * emoji y Esc lo cierra. La reacción sale por WhatsApp; si el proveedor la rechaza, el motivo se muestra debajo de la burbuja.
 */
function ReactMenu({ m, onReact }: { m: ChatMessage; onReact: (id: string, emoji: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (emoji: string | null): void => { setOpen(false); onReact(m.id, emoji); };
  return (
    <span className="relative self-center" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
      <button type="button" aria-label="Reaccionar al mensaje" aria-expanded={open} title="Reaccionar" onClick={() => setOpen((v) => !v)} className="grid size-8 place-items-center rounded-full text-[15px] text-muted opacity-60 max-md:size-11 hover:bg-surface2 hover:opacity-100 focus-visible:opacity-100 max-lg:size-11">☺</button>
      {open ? (
        <span role="group" aria-label="Elige una reacción" className="absolute bottom-full left-0 z-10 mb-1 flex gap-0.5 rounded-full border border-line bg-surface p-1 shadow-[var(--shadow)]">
          {QUICK_REACTIONS.map((e) => (
            <button key={e} type="button" aria-label={`Reaccionar con ${e}`} aria-pressed={m.my_reaction === e} onClick={() => pick(m.my_reaction === e ? null : e)} className={`grid size-9 place-items-center rounded-full text-[19px] hover:bg-surface2 max-lg:size-11 ${m.my_reaction === e ? 'bg-accent-soft' : ''}`}>{e}</button>
          ))}
          {m.my_reaction ? <button type="button" aria-label="Quitar mi reacción" title="Quitar mi reacción" onClick={() => pick(null)} className="grid size-9 place-items-center rounded-full text-[14px] text-muted hover:bg-surface2 max-lg:size-11">✕</button> : null}
        </span>
      ) : null}
    </span>
  );
}

/** Quién habló en el mensaje citado, en una palabra o dos. */
export function quoteWho(q: ReplyQuote, contactName: string): string {
  if (q.direction === 'in') return contactName;
  if (q.sender_type === 'ai') return 'Agente de IA';
  if (q.sender_type === 'automation') return 'Mensaje automático';
  return q.author ? personName(q.author.name) : 'Equipo';
}

/** La cita dentro de una burbuja: barra de color, quién y qué (texto o tipo de contenido); tocarla lleva al mensaje original si está en pantalla. */
export function QuoteBlock({ quote, contactName, onJump }: { quote: ReplyQuote; contactName: string; onJump?: ((id: string) => void) | undefined }) {
  const who = quoteWho(quote, contactName);
  const what = quote.text ?? kindLabel(quote.kind);
  return (
    <button type="button" aria-label={`Mensaje citado de ${who}: ${what}. Ir al mensaje`} onClick={() => onJump?.(quote.id)} className="mb-1 block w-full min-w-0 rounded-md border-l-4 border-current bg-black/[.07] px-2 py-1 text-left">
      <b className="block truncate text-[12px]">{who}</b>
      <span className="line-clamp-2 break-words text-[12.5px]">{what}</span>
    </button>
  );
}

/** Una burbuja del hilo: del cliente (izquierda), nuestra (derecha, con su estado de envío) o una nota interna (centrada, nunca sale al cliente). */
export function MessageBubble({ m, canRetry, retrying, onRetry, onReact, avatar, spacing = '', contactName = '', onReply, onJump }: { spacing?: string; m: ChatMessage; canRetry: boolean; retrying: boolean; onRetry: (id: string) => void; onReact?: ((id: string, emoji: string | null) => void) | undefined; avatar?: ReactNode; contactName?: string; /** Si se puede responder citando este mensaje (v13 S3.3): lo que hace el gesto, el botón «Responder» y el teclado. */ onReply?: ((m: ChatMessage) => void) | undefined; onJump?: ((id: string) => void) | undefined }) {
  const mobile = useBreakpoint() === 'mobile';
  const swipe = useSwipeReply({ enabled: mobile && onReply !== undefined && !m.is_note, onReply: () => onReply?.(m) });
  if (m.is_note) {
    const auto = m.sender_type === 'system';
    return (
      <li className={`flex justify-center ${spacing}`}>
        <div className={`max-w-[82%] rounded-lg px-3 py-2 text-[13.5px] ${auto ? 'bg-surface2 text-muted' : 'bg-warn-soft text-warn'}`}>
          <b className="mr-1">{auto ? 'Aviso automático' : `Nota interna${m.author ? ` · ${personName(m.author.name)}` : ''}`}</b>
          <Body m={m} />
          <time dateTime={m.sent_at} className="mt-0.5 block text-right text-[11px] opacity-70">{bubbleTime(m.sent_at)}</time>
        </div>
      </li>
    );
  }
  const out = m.direction === 'out';
  // v13 S3.1: lo que escribe una persona lleva el color del tema; el agente de IA y los avisos automáticos, una variante suave (con su etiqueta) para distinguirse sin perder contraste
  const grad = out && m.sender_type !== 'ai' && m.sender_type !== 'automation';
  const canReact = !out && onReact !== undefined;
  const replyButton = onReply ? (
    <button type="button" aria-label="Responder a este mensaje" title="Responder" onClick={() => onReply(m)} className="grid size-8 shrink-0 place-items-center self-center rounded-full text-muted opacity-0 hover:bg-surface2 hover:opacity-100 focus-visible:opacity-100 group-hover/msg:opacity-100 max-md:sr-only max-md:focus-visible:not-sr-only max-md:focus-visible:size-11 max-md:focus-visible:opacity-100"><Icon name="reply" size={16} /></button>
  ) : null;
  return (
    <li id={`msg-${m.id}`} className={`group/msg relative ${spacing}`}>
      {onReply ? <span aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-surface2 text-muted" style={{ opacity: swipe.progress, transform: `translateY(-50%) scale(${0.6 + 0.4 * swipe.progress})` }}><Icon name="reply" size={16} /></span> : null}
      <div className={`flex gap-2 ${out ? 'flex-row-reverse' : ''}`} style={swipe.style} {...swipe.handlers}>
      {avatar !== undefined ? <span className="w-7 shrink-0 self-start">{avatar}</span> : null}
      <div className={`flex min-w-0 flex-1 flex-col ${out ? 'items-end' : 'items-start'}`}>
      <div className={`flex w-full min-w-0 items-start gap-1 ${out ? 'justify-end' : ''}`}>
      {out ? replyButton : null}
      <div className={`relative w-fit min-w-24 max-w-[min(80%,420px)] break-words rounded-lg px-3 py-2 text-[14px] [box-shadow:var(--bubble-shadow)] ${m.reaction || m.my_reaction ? 'mb-3' : ''} ${grad ? 'bubble-grad rounded-tr-sm' : out ? 'rounded-tr-sm bg-[var(--bubble-out)] text-fg' : 'rounded-tl-sm border border-line bg-[var(--bubble-in)] text-fg'}`}>
        {out && m.author ? <span className="mb-0.5 block text-[11px] font-semibold text-muted">{firstName(m.author.name)}</span> : null}
        {out && m.sender_type === 'ai' ? <span className="mb-0.5 block text-[11px] font-semibold text-muted">Agente de IA</span> : null}
        {out && m.sender_type === 'automation' ? <span className="mb-0.5 block text-[11px] font-semibold text-muted">Mensaje automático</span> : null}
        {m.template ? <span className="mb-0.5 block text-[11px] font-semibold text-muted">Plantilla · <span className="font-mono">{m.template.name}</span></span> : null}
        {m.reply_to ? <QuoteBlock quote={m.reply_to} contactName={contactName} onJump={onJump} /> : null}
        <Body m={m} />
        {m.template && m.template.buttons.length > 0 ? (
          <span className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Botones de la plantilla">
            {m.template.buttons.map((b, i) => <span key={i} className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12px] font-semibold text-accent">{b.text}</span>)}
          </span>
        ) : null}
        <span className="mt-0.5 flex items-center justify-end text-[11px] text-muted">
          {out && m.extra?.['origin'] === 'device' ? <span className="mr-1">Desde el teléfono ·</span> : null}
          <time dateTime={m.sent_at}>{bubbleTime(m.sent_at)}</time>
          {out ? <Ticks status={m.status} onGrad={grad} /> : null}
        </span>
        {m.reaction ? <span role="img" aria-label={`Reacción del cliente: ${m.reaction}`} className="absolute -bottom-3 right-2 rounded-full border border-line bg-surface px-1.5 py-0.5 text-[13px] leading-none shadow-sm">{m.reaction}</span> : null}
        {m.my_reaction ? <span role="img" aria-label={`Tu reacción: ${m.my_reaction}`} className="absolute -bottom-3 left-2 rounded-full border border-accent bg-accent-soft px-1.5 py-0.5 text-[13px] leading-none shadow-sm">{m.my_reaction}</span> : null}
      </div>
      {canReact ? <ReactMenu m={m} onReact={onReact} /> : null}
      {out ? null : replyButton}
      </div>
      {m.status === 'failed' ? (
        <div role="alert" className="mt-1 flex max-w-[78%] flex-wrap items-center justify-end gap-2 text-right text-[12.5px] text-crit">
          <span>{m.error ?? 'No se pudo enviar el mensaje.'}</span>
          {canRetry ? <Button variant="link" className="text-[12.5px]" loading={retrying} onClick={() => onRetry(m.id)}>Reintentar</Button> : null}
        </div>
      ) : null}
      </div>
      </div>
    </li>
  );
}
