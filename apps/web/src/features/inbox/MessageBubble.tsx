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
import { AudioPlayer, useStableUrl } from './AudioPlayer';
import { validPlace, type Place } from '../../lib/osm';

/** Estado de entrega (V23-B): como WhatsApp, un check gris al enviarse, dos al entregarse y dos AZULES solo al leerse. Íconos SVG (no caracteres) con el solapamiento de WhatsApp. */
const TICK_LABEL: Record<string, string> = { queued: 'Enviando', sent: 'Enviado', delivered: 'Entregado', read: 'Leído', failed: 'No se pudo enviar' };

function Ticks({ status }: { status: ChatMessage['status'] }) {
  const label = TICK_LABEL[status];
  if (!label) return null;
  if (status === 'queued') return <span role="img" aria-label={label} title={label} className="ml-1 text-[var(--tick-grey)]">◷</span>;
  if (status === 'failed') return <span role="img" aria-label={label} title={label} className="ml-1 font-bold text-crit">!</span>;
  const color = status === 'read' ? 'text-[var(--tick-read)]' : 'text-[var(--tick-grey)]';
  return (
    <span role="img" aria-label={label} title={label} className={`ml-1 inline-flex ${color}`}>
      <svg width={status === 'sent' ? 12 : 17} height="11" viewBox={status === 'sent' ? '0 0 12 11' : '0 0 17 11'} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M1.5 6l3 3L10.5 1.8" />
        {status === 'sent' ? null : <path d="M6 6l3 3L15.5 1.8" />}
      </svg>
    </span>
  );
}

/** Una imagen del hilo. En móvil se toca para verla ampliada a pantalla completa (con botón de cerrar); en escritorio es un enlace a otra pestaña, como siempre. */
/** El video con una dirección estable: si el hilo se vuelve a pedir y la dirección firmada cambia, el video no se recarga a media reproducción. */
function ChatVideo({ id, url, bleed = false }: { id: string; url: string; bleed?: boolean }) {
  const [src, refresh] = useStableUrl(id, url);
  return <video src={src} controls preload="metadata" onError={() => { refresh(); }} className={bleed ? 'block w-full' : 'max-w-full rounded-lg'} />;
}

function ChatImage({ url, name, bleed = false }: { url: string; name: string; bleed?: boolean }) {
  const imgCls = bleed ? 'block h-auto max-h-[420px] w-full object-cover' : 'h-auto max-w-full rounded-lg';
  const wrapCls = bleed ? 'block w-full' : 'mt-1 block max-w-full';
  const mobile = useBreakpoint() === 'mobile';
  const [open, setOpen] = useState(false);
  if (!mobile) return <a href={url} target="_blank" rel="noopener noreferrer" className={wrapCls}><img src={url} alt={name} className={imgCls} loading="lazy" /></a>;
  return (
    <>
      <button type="button" aria-label="Ver la imagen ampliada" onClick={() => setOpen(true)} className={wrapCls}><img src={url} alt={name} className={imgCls} loading="lazy" /></button>
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
          : att.mime_type?.startsWith('video/') ? <><span className="mb-0.5 block text-[12px] font-semibold opacity-80">Video</span><ChatVideo id={att.id} url={att.url} /></>
          : att.mime_type?.startsWith('audio/') ? <AudioPlayer id={att.id} url={att.url} filename={att.filename} />
          : <DocumentCard url={att.url} mime={att.mime_type} size={att.size_bytes} filename={att.filename} />
        ) : att.scan_status === 'skipped' && m.kind !== 'text' ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo aún no se puede ver aquí · sin revisar</span>
        : m.media ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo aún no se puede ver aquí.</span> : null
      ) : m.media ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo aún no se puede ver aquí.</span> : null}
      {m.transcript ? (
        <span className="mt-1 block rounded-lg border border-line/60 bg-black/5 px-2 py-1.5 text-[12.5px]">
          <span className="block text-[11px] font-semibold opacity-80">Transcripción por IA · puede contener errores</span>
          <span className="block whitespace-pre-wrap break-words">{m.transcript.text}</span>
        </span>
      ) : null}
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
export function MessageBubble({ m, canRetry, retrying, onRetry, onReact, avatar, spacing = '', contactName = '', onReply, onJump, tail = true }: { /** La primera burbuja de un grupo lleva la esquina en «pico»; las siguientes, no. */ tail?: boolean; spacing?: string; m: ChatMessage; canRetry: boolean; retrying: boolean; onRetry: (id: string) => void; onReact?: ((id: string, emoji: string | null) => void) | undefined; avatar?: ReactNode; contactName?: string; /** Si se puede responder citando este mensaje (v13 S3.3): lo que hace el gesto, el botón «Responder» y el teclado. */ onReply?: ((m: ChatMessage) => void) | undefined; onJump?: ((id: string) => void) | undefined }) {
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
  const att = m.attachment;
  // V23-B: imagen o video a borde de la burbuja, sin marco; el pie va debajo y la hora sobre la foto cuando no hay pie
  const bleed = !!att?.url && att.scan_status !== 'infected' && att.scan_status !== 'pending' && (att.mime_type?.startsWith('image/') === true || att.mime_type?.startsWith('video/') === true);
  const isImage = att?.mime_type?.startsWith('image/') === true;
  const overlayTime = bleed && isImage && !m.text;
  const canReact = !out && onReact !== undefined;
  const replyButton = onReply ? (
    <button type="button" aria-label="Responder a este mensaje" title="Responder" onClick={() => onReply(m)} className="grid size-8 shrink-0 place-items-center self-center rounded-full text-muted opacity-0 hover:bg-surface2 hover:opacity-100 focus-visible:opacity-100 group-hover/msg:opacity-100 max-md:sr-only max-md:focus-visible:not-sr-only max-md:focus-visible:size-11 max-md:focus-visible:opacity-100"><Icon name="reply" size={16} /></button>
  ) : null;
  return (
    <li id={`msg-${m.id}`} className={`group/msg relative ${spacing}`}>
      {onReply ? <span aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-surface2 text-muted" style={{ opacity: swipe.progress, transform: `translateY(-50%) scale(${0.6 + 0.4 * swipe.progress})` }}><Icon name="reply" size={16} /></span> : null}
      <div className={`flex gap-2 ${out ? 'flex-row-reverse' : ''}`} style={swipe.style} {...swipe.handlers}>
      {avatar !== undefined ? <span className="w-6 shrink-0 self-start">{avatar}</span> : null}
      <div className={`flex min-w-0 flex-1 flex-col ${out ? 'items-end' : 'items-start'}`}>
      <div className={`flex w-full min-w-0 items-start gap-1 ${out ? 'justify-end' : ''}`}>
      {out ? replyButton : null}
      <div className={`relative w-fit min-w-24 max-w-[min(80%,420px)] break-words rounded-lg text-[14px] [box-shadow:var(--bubble-shadow)] ${m.reaction || m.my_reaction ? 'mb-3' : ''} ${bleed ? 'w-[78%] p-0 md:w-[330px]' : 'px-3 py-2'} ${out ? `${tail ? 'rounded-tr-sm ' : ''}bg-[var(--bubble-out)] text-[var(--bubble-text)]` : `${tail ? 'rounded-tl-sm ' : ''}bg-[var(--bubble-in)] text-[var(--bubble-text)]`}`}>
        <div className={bleed ? 'px-3 pt-2 empty:hidden' : 'contents'}>
          {out && m.author ? <span className="mb-0.5 block text-[11px] font-semibold text-[var(--bubble-time)]">{firstName(m.author.name)}</span> : null}
          {out && m.sender_type === 'ai' ? <span className="mb-0.5 block text-[11px] font-semibold text-[var(--bubble-time)]">Agente de IA</span> : null}
          {out && m.sender_type === 'automation' ? <span className="mb-0.5 block text-[11px] font-semibold text-[var(--bubble-time)]">Mensaje automático</span> : null}
          {m.template ? <span className="mb-0.5 block text-[11px] font-semibold text-[var(--bubble-time)]">Plantilla · <span className="font-mono">{m.template.name}</span></span> : null}
          {m.reply_to ? <QuoteBlock quote={m.reply_to} contactName={contactName} onJump={onJump} /> : null}
        </div>
        {bleed && att?.url ? (
          <div className={`relative overflow-hidden ${m.reply_to || (out && (m.author || m.sender_type === 'ai' || m.sender_type === 'automation')) || m.template ? 'mt-1.5' : 'rounded-t-lg'} ${m.text ? '' : 'rounded-b-lg'}`}>
            {isImage ? <ChatImage url={att.url} name="Imagen" bleed /> : <ChatVideo id={att.id} url={att.url} bleed />}
            {overlayTime ? (
              <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-end bg-gradient-to-t from-black/60 to-transparent px-2 pb-1 pt-6 text-[11px] text-white [--bubble-time:#fff] [--tick-grey:#fff] [--tick-read:#7fd4ff]">
                <time dateTime={m.sent_at}>{bubbleTime(m.sent_at)}</time>
                {out ? <Ticks status={m.status} /> : null}
              </span>
            ) : null}
          </div>
        ) : <Body m={m} />}
        {bleed && m.text ? <span className="block whitespace-pre-wrap break-words px-3 pt-1.5">{m.text}</span> : null}
        {m.template && m.template.buttons.length > 0 ? (
          <span className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Botones de la plantilla">
            {m.template.buttons.map((b, i) => <span key={i} className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12px] font-semibold text-accent">{b.text}</span>)}
          </span>
        ) : null}
        {overlayTime ? null : (
          <span className={`mt-0.5 flex items-center justify-end text-[11px] text-[var(--bubble-time)] ${bleed ? 'px-3 pb-1.5' : ''}`}>
            {out && m.extra?.['origin'] === 'device' ? <span className="mr-1">Desde el teléfono ·</span> : null}
            <time dateTime={m.sent_at}>{bubbleTime(m.sent_at)}</time>
            {out ? <Ticks status={m.status} /> : null}
          </span>
        )}
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
