import { useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Conversation, ResolvedQuickReply } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { QuickRepliesDialog } from '../quick-replies/QuickRepliesPanel';
import { TemplatePicker } from './TemplatePicker';
import { useConversationQuickReplies, useSendNote, useSendReply } from './useInbox';

const MAX = 4096;
const MAX_SUGGESTIONS = 6;

/** Una variable de una respuesta rápida que no se pudo llenar: `{{contact.ciudad}}`. */
const UNFILLED = /\{\{\s*[A-Za-z0-9_.]+\s*\}\}/g;

/** Por qué no se le puede escribir al cliente ahora (con lo que la persona puede hacer al respecto), o null si se puede. */
export function replyBlock(c: Conversation): string | null {
  if (c.status === 'closed') return 'La conversación está finalizada. Si el cliente escribe de nuevo, se abrirá otra.';
  if (c.status === 'unassigned') return c.can.take ? 'Esta conversación aún no tiene asesor. Asígnatela para poder responder.' : 'Esta conversación aún no tiene asesor.';
  if (!c.can.reply && c.channel.state !== 'active') return 'La conexión de WhatsApp de esta conversación está desactivada o desconectada.';
  if (!c.can.reply && c.my_access === 'collaborator_view') return 'Te compartieron esta conversación solo para ver y dejar notas: no puedes escribirle al cliente.';
  if (!c.can.reply && c.my_access === 'collaborator_reply' && c.status === 'pending') return `${c.owner?.name ?? 'Quien la tiene'} aún no acepta la conversación: podrás responder cuando lo haga.`;
  if (!c.can.reply) return c.owner ? `Solo ${c.owner.name} puede responder esta conversación.` : 'No puedes responder esta conversación.';
  if (!c.window.open) return 'Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite escribirle con una plantilla aprobada: usa el botón «Plantillas».';
  return null;
}

/** La palabra que se está escribiendo tras una barra (`/pre`) justo antes del cursor, con dónde empieza la barra; null si no hay. La barra debe abrir el texto o ir tras un espacio. */
export function slashAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)\/([A-Za-z0-9_-]*)$/.exec(text.slice(0, caret));
  return m ? { start: m.index + m[1]!.length, query: m[2]!.toLowerCase() } : null;
}

/** Las respuestas que encajan con lo escrito: primero las que empiezan por eso y luego las que lo contienen. */
export function suggest(items: readonly ResolvedQuickReply[], query: string): ResolvedQuickReply[] {
  const starts = items.filter((r) => r.shortcut.startsWith(query));
  const contains = query === '' ? [] : items.filter((r) => !r.shortcut.startsWith(query) && r.shortcut.includes(query));
  return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
}

/**
 * Redactor del hilo: «Responder» (sale al cliente por WhatsApp) o «Nota interna» (solo la ve el equipo y nunca sale). Enter envía y Mayús+Enter da un salto de línea.
 * Escribir «/» abre las respuestas rápidas (M5.6b): se filtra al escribir, se elige con las flechas y Enter o con un clic, y se inserta ya con los datos del contacto.
 * Lo que no se pudo llenar queda marcado como `{{variable}}` y no deja enviar hasta completarlo.
 * Cuando no se puede escribir al cliente explica por qué; las notas siguen disponibles para quien tenga permiso.
 */
export function Composer({ c }: { c: Conversation }) {
  const reply = useSendReply(c.id);
  const note = useSendNote(c.id);
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [picker, setPicker] = useState(false);
  const [manage, setManage] = useState(false);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const block = replyBlock(c);
  const noteMode = mode === 'note' || block !== null;
  const canWrite = noteMode ? c.can.note : true;
  const send = noteMode ? note : reply;
  const trimmed = text.trim();
  const quick = useConversationQuickReplies(c.id, c.can.reply && !noteMode);
  const slash = !noteMode && c.can.reply ? slashAt(text, caret) : null;
  const options = useMemo(() => (slash && quick.data ? suggest(quick.data.items, slash.query) : []), [slash, quick.data]);
  const open = slash !== null && closedAt !== slash.start && quick.isSuccess;
  const pending = noteMode ? [] : [...new Set(text.match(UNFILLED) ?? [])];

  if (!c.can.reply && !c.can.note) return block ? <p className="border-t border-line bg-surface px-4 py-3 text-[13px] text-muted">{block}</p> : null;

  const submit = (): void => {
    if (!trimmed || send.isPending || !canWrite || pending.length > 0) return;
    // El texto se limpia al enviar (no al terminar de refrescar la lista): si no, lo que la persona ya empezó a escribir después —una nota, el siguiente mensaje— se borraría
    // cuando llegue la respuesta. Si el envío falla, el texto vuelve, salvo que ya haya escrito otra cosa.
    setText('');
    setCaret(0);
    ref.current?.focus();
    send.mutate(trimmed, { onError: () => setText((cur) => (cur === '' ? trimmed : cur)) });
  };

  /** Pone la respuesta (ya resuelta) en lugar de «/atajo» y deja el cursor al final de lo insertado. */
  const insert = (r: ResolvedQuickReply): void => {
    if (!slash) return;
    const next = `${text.slice(0, slash.start)}${r.text}${text.slice(caret)}`.slice(0, MAX);
    const at = Math.min(slash.start + r.text.length, MAX);
    setText(next);
    setCaret(at);
    setActive(0);
    if (send.isError) send.reset();
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    setText(e.target.value);
    setCaret(e.target.selectionStart);
    setActive(0);
    setClosedAt(null);
    if (send.isError) send.reset();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open && options.length > 0 && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insert(options[Math.min(active, options.length - 1)]!);
        return;
      }
    }
    if (open && e.key === 'Escape' && slash) {
      e.preventDefault();
      setClosedAt(slash.start);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={`grid gap-2 border-t border-line px-3 py-2.5 ${noteMode ? 'bg-warn-soft' : 'bg-surface'}`}>
      {block ? <p role="status" className="text-[12.5px] text-muted">{block}</p> : null}
      {c.can.reply ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {c.can.note ? (
        <div role="group" aria-label="Qué vas a escribir" className="flex gap-1.5">
          <button type="button" aria-pressed={mode === 'reply' && block === null} disabled={block !== null} onClick={() => setMode('reply')} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold disabled:opacity-50 ${mode === 'reply' && block === null ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>Responder</button>
          <button type="button" aria-pressed={noteMode} onClick={() => setMode('note')} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold ${noteMode ? 'border-warn bg-warn-soft text-warn' : 'border-line text-muted hover:text-fg'}`}>Nota interna</button>
        </div>
          ) : null}
          <button type="button" onClick={() => setPicker(true)} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold ${c.window.open ? 'border-line text-muted hover:text-fg' : 'border-accent bg-accent text-accent-ink'}`}>Plantillas</button>
          <button type="button" onClick={() => setManage(true)} className="rounded-full border border-line px-3 py-1 text-[12.5px] font-semibold text-muted hover:text-fg">Respuestas rápidas</button>
        </div>
      ) : null}
      {picker ? <TemplatePicker c={c} onClose={() => setPicker(false)} /> : null}
      {manage ? <QuickRepliesDialog onClose={() => setManage(false)} /> : null}
      {send.isError ? <Alert>{friendlyError(send.error, noteMode ? 'No pudimos guardar la nota.' : 'No pudimos enviar el mensaje.')}</Alert> : null}
      {pending.length > 0 ? <Alert kind="info">Falta completar {pending.join(', ')}: reemplázalo con el dato real antes de enviar.</Alert> : null}
      <div className="relative flex items-end gap-2">
        {open ? (
          <div className="absolute inset-x-0 bottom-full z-10 mb-1.5 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow)]">
            {options.length > 0 ? (
              <ul id={listId} role="listbox" aria-label="Respuestas rápidas" className="grid gap-0.5">
                {options.map((r, i) => (
                  // El foco se queda en el cuadro de texto (el mousedown no lo quita): se elige con el clic, o con el teclado desde el cuadro
                  <li key={r.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(r)} onMouseEnter={() => setActive(i)} className={`grid cursor-pointer gap-0.5 rounded-lg px-2.5 py-1.5 text-left ${i === active ? 'bg-accent-soft' : 'hover:bg-surface2'}`}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <b className="font-mono text-[13px]">/{r.shortcut}</b>
                        {r.shared ? <Pill kind="info">Compartida</Pill> : null}
                        {r.missing.length > 0 ? <Pill kind="warn">Falta: {r.missing.map((m) => m.replace(/^contact\./, '')).join(', ')}</Pill> : null}
                      </span>
                      <span className="line-clamp-2 whitespace-pre-wrap text-[12.5px] text-muted">{r.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status" className="px-2.5 py-2 text-[12.5px] text-muted">{quick.data && quick.data.items.length === 0 ? 'Aún no tienes respuestas rápidas. Crea una con el botón «Respuestas rápidas».' : `No hay una respuesta que se llame «/${slash?.query ?? ''}».`}</p>
            )}
          </div>
        ) : null}
        <textarea
          ref={ref}
          rows={2}
          value={text}
          maxLength={MAX}
          disabled={!canWrite}
          aria-label={noteMode ? 'Nota interna' : 'Mensaje'}
          {...(open && options.length > 0 ? { 'aria-controls': listId, 'aria-activedescendant': `${listId}-${Math.min(active, options.length - 1)}`, 'aria-expanded': true } : {})}
          placeholder={noteMode ? 'Nota interna: solo la ve tu equipo' : 'Escribe un mensaje o «/» para una respuesta rápida'}
          onChange={onChange}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
          className="max-h-40 min-h-[44px] flex-1 resize-none rounded-[14px] border border-line bg-surface px-3.5 py-2.5 text-[14px] placeholder:text-muted/70 disabled:opacity-60"
        />
        <Button variant="primary" loading={send.isPending} disabled={!trimmed || !canWrite || pending.length > 0} onClick={submit}>{noteMode ? 'Guardar nota' : 'Enviar'}</Button>
      </div>
    </div>
  );
}
