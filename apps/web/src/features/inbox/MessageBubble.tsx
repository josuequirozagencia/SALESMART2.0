import type { ChatMessage } from '../../lib/types';
import { Button } from '../../ui/controls';
import { bubbleTime, describeExtra, kindLabel } from './inboxFormat';

const TICK: Record<string, { text: string; label: string; cls: string }> = {
  queued: { text: '◷', label: 'Enviando', cls: 'opacity-60' },
  sent: { text: '✓', label: 'Enviado', cls: 'opacity-60' },
  delivered: { text: '✓✓', label: 'Entregado', cls: 'opacity-60' },
  read: { text: '✓✓', label: 'Leído', cls: 'text-info opacity-100' },
  failed: { text: '!', label: 'No se pudo enviar', cls: 'text-crit font-bold opacity-100' },
};

function Ticks({ status }: { status: ChatMessage['status'] }) {
  const t = TICK[status];
  return t ? <span role="img" aria-label={t.label} title={t.label} className={`ml-1 tracking-[-2px] ${t.cls}`}>{t.text}</span> : null;
}

/** El contenido: texto, o el nombre del tipo de contenido cuando no hay texto (los archivos aún no se descargan: llega en M5.6). */
function Body({ m }: { m: ChatMessage }) {
  const extra = describeExtra(m);
  const isText = m.kind === 'text' || m.kind === 'note' || m.kind === 'template';
  const att = m.attachment;
  return (
    <>
      {!isText ? (
        <span className="mb-0.5 block text-[12px] font-semibold opacity-80">
          {kindLabel(m.kind)}{m.media?.filename || att?.filename ? ` · ${att?.filename ?? m.media?.filename}` : ''}
        </span>
      ) : null}
      {m.text ? <span className="block whitespace-pre-wrap break-words">{m.text}</span> : null}
      {extra ? <span className="block text-[12.5px] opacity-80">{extra}</span> : null}
      {att ? (
        att.scan_status === 'infected' ? <span className="mt-0.5 block text-[12px] font-semibold text-crit">El antivirus bloqueó este archivo{att.error ? `: ${att.error}` : ''}</span>
        : att.scan_status === 'pending' ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo se está revisando…</span>
        : att.url ? (
          att.mime_type?.startsWith('image/') ? <a href={att.url} target="_blank" rel="noopener noreferrer" className="mt-1 block"><img src={att.url} alt={att.filename ?? 'imagen'} className="max-w-[260px] rounded-lg" loading="lazy" /></a>
          : att.mime_type?.startsWith('video/') ? <video src={att.url} controls className="mt-1 max-w-[260px] rounded-lg" />
          : att.mime_type?.startsWith('audio/') ? <audio src={att.url} controls className="mt-1 w-full max-w-[260px]" />
          : <a href={att.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[12.5px] font-semibold text-accent">Descargar {att.filename ?? 'archivo'}</a>
        ) : att.scan_status === 'skipped' && m.kind !== 'text' ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo aún no se puede ver aquí{att.filename ? ` · ${att.filename}` : ''} · sin revisar</span>
        : m.media ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo aún no se puede ver aquí.</span> : null
      ) : m.media ? <span className="mt-0.5 block text-[12px] italic opacity-70">El archivo aún no se puede ver aquí.</span> : null}
    </>
  );
}

/** Una burbuja del hilo: del cliente (izquierda), nuestra (derecha, con su estado de envío) o una nota interna (centrada, nunca sale al cliente). */
export function MessageBubble({ m, canRetry, retrying, onRetry }: { m: ChatMessage; canRetry: boolean; retrying: boolean; onRetry: (id: string) => void }) {
  if (m.is_note) {
    const auto = m.sender_type === 'system';
    return (
      <li className="flex justify-center">
        <div className={`max-w-[82%] rounded-lg px-3 py-2 text-[13.5px] ${auto ? 'bg-surface2 text-muted' : 'bg-warn-soft text-warn'}`}>
          <b className="mr-1">{auto ? 'Aviso automático' : `Nota interna${m.author ? ` · ${m.author.name}` : ''}`}</b>
          <Body m={m} />
          <time dateTime={m.sent_at} className="mt-0.5 block text-right text-[11px] opacity-70">{bubbleTime(m.sent_at)}</time>
        </div>
      </li>
    );
  }
  const out = m.direction === 'out';
  return (
    <li className={`flex flex-col ${out ? 'items-end' : 'items-start'}`}>
      <div className={`relative max-w-[78%] rounded-lg px-3 py-2 text-[14px] shadow-sm ${m.reaction ? 'mb-3' : ''} ${out ? 'rounded-tr-sm bg-accent-soft text-fg' : 'rounded-tl-sm border border-line bg-surface text-fg'}`}>
        {out && m.author ? <span className="mb-0.5 block text-[11px] font-semibold text-muted">{m.author.name.split(' ')[0]}</span> : null}
        {out && m.sender_type === 'automation' ? <span className="mb-0.5 block text-[11px] font-semibold text-muted">Mensaje automático</span> : null}
        {m.template ? <span className="mb-0.5 block text-[11px] font-semibold text-muted">Plantilla · <span className="font-mono">{m.template.name}</span></span> : null}
        <Body m={m} />
        {m.template && m.template.buttons.length > 0 ? (
          <span className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Botones de la plantilla">
            {m.template.buttons.map((b, i) => <span key={i} className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12px] font-semibold text-accent">{b.text}</span>)}
          </span>
        ) : null}
        <span className="mt-0.5 flex items-center justify-end text-[11px] text-muted">
          <time dateTime={m.sent_at}>{bubbleTime(m.sent_at)}</time>
          {out ? <Ticks status={m.status} /> : null}
        </span>
        {m.reaction ? <span role="img" aria-label={`Reacción del cliente: ${m.reaction}`} className="absolute -bottom-3 right-2 rounded-full border border-line bg-surface px-1.5 py-0.5 text-[13px] leading-none shadow-sm">{m.reaction}</span> : null}
      </div>
      {m.status === 'failed' ? (
        <div role="alert" className="mt-1 flex max-w-[78%] flex-wrap items-center justify-end gap-2 text-right text-[12.5px] text-crit">
          <span>{m.error ?? 'No se pudo enviar el mensaje.'}</span>
          {canRetry ? <Button variant="link" className="text-[12.5px]" loading={retrying} onClick={() => onRetry(m.id)}>Reintentar</Button> : null}
        </div>
      ) : null}
    </li>
  );
}
