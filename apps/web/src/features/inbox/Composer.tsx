import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Conversation, MentionOption, ResolvedQuickReply } from '../../lib/types';
import { useBreakpoint } from '../../ui/breakpoints';
import { Alert, Button } from '../../ui/controls';
import { Drawer } from '../../ui/Drawer';
import { Icon } from '../../ui/Icon';
import { Pill } from '../../ui/Pill';
import { QuickRepliesDialog } from '../quick-replies/QuickRepliesPanel';
import { AttachmentPicker } from './AttachmentPicker';
import { ClipIcon, IconButton, MicIcon, mmss, SmileIcon, StopIcon, useVoiceRecorder, XIcon } from './composerParts';
import { readDraft, writeDraft } from './draftStore';
import { EmojiPicker } from './EmojiPicker';
import { mentionAt, mentionIdsIn, suggestMentions, type Picked } from './mentions';
import { kindLabel } from './inboxFormat';
import { ScheduleDialog } from './ScheduleDialog';
import { SheetButton } from './SheetButton';
import { TemplatePicker } from './TemplatePicker';
import { useConversationQuickReplies, useMentionOptions, useSendMedia, useSendNote, useSendReply, useUploadAttachment } from './useInbox';

const MAX = 4096;
const MAX_SUGGESTIONS = 6;

/** Una variable de una respuesta rápida que no se pudo llenar: `{{contact.ciudad}}`. */
const UNFILLED = /\{\{\s*[A-Za-z0-9_.]+\s*\}\}/g;

/** Por qué no se le puede escribir al cliente ahora (con lo que la persona puede hacer al respecto), o null si se puede. */
export function replyBlock(c: Conversation): string | null {
  if (c.status === 'closed') return 'La conversación está finalizada. Si el cliente escribe de nuevo, se abrirá otra.';
  if (c.status === 'unassigned') return c.can.take ? 'Esta conversación aún no tiene asesor. Asígnatela para poder responder.' : 'Esta conversación aún no tiene asesor.';
  if (!c.can.reply && c.channel.state !== 'active') return c.channel.kind === 'ghl' ? 'La conexión con GoHighLevel está desconectada o su token fue rechazado: el administrador debe revisarla en Configuración › GoHighLevel.' : 'La conexión de WhatsApp de esta conversación está desactivada o desconectada.';
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
  const media = useSendMedia(c.id);
  const [mode, setMode] = useState<'reply' | 'note'>(() => readDraft(c.id).mode);
  const [text, setText] = useState(() => readDraft(c.id).text);
  const [caret, setCaret] = useState(() => readDraft(c.id).text.length);
  const [picker, setPicker] = useState(false);
  const [manage, setManage] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [emojis, setEmojis] = useState(false);
  const [voiceError, setVoiceError] = useState<string>();
  const [pendingAttachment, setPendingAttachment] = useState<{ id: string; filename: string; kind: string } | null>(null);
  const upload = useUploadAttachment(c.id);
  const voice = useVoiceRecorder((file) => {
    setVoiceError(undefined);
    upload.mutate(file, { onSuccess: (a) => setPendingAttachment({ id: a.id, filename: a.filename ?? 'nota de voz', kind: a.kind }), onError: (e) => setVoiceError(friendlyError(e, 'No pudimos subir la nota de voz.')) });
  });
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  // Menciones «@» (F1, ADR-57): quiénes se eligieron y la «@» cuya lista se cerró con Esc
  const [picked, setPicked] = useState<Picked[]>([]);
  const [mentionClosedAt, setMentionClosedAt] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  // Móvil (ADR-60, Fase 5): el borrador de cada conversación se conserva al volver a la lista y reabrirla (solo en memoria de esta sesión); Enter da salto de línea y se envía con el botón;
  // el cuadro crece hasta ~5 líneas; las acciones secundarias van en una hoja inferior
  const mobile = useBreakpoint() === 'mobile';
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    writeDraft(c.id, { text, mode });
  }, [c.id, text, mode]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !mobile) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text, mobile]);
  const block = replyBlock(c);
  const noteMode = mode === 'note' || block !== null;
  const canWrite = noteMode ? c.can.note : true;
  const send = noteMode ? note : pendingAttachment ? (media as unknown as typeof reply) : reply;
  const trimmed = text.trim();
  const quick = useConversationQuickReplies(c.id, c.can.reply && !noteMode);
  const slash = !noteMode && c.can.reply ? slashAt(text, caret) : null;
  const options = useMemo(() => (slash && quick.data ? suggest(quick.data.items, slash.query) : []), [slash, quick.data]);
  const open = slash !== null && closedAt !== slash.start && quick.isSuccess;
  const pending = noteMode ? [] : [...new Set(text.match(UNFILLED) ?? [])];
  const mention = noteMode && c.can.note ? mentionAt(text, caret) : null;
  const mentionData = useMentionOptions(c.id, noteMode && c.can.note);
  const people = useMemo(() => (mention && mentionData.data ? suggestMentions(mentionData.data.items, mention.query) : []), [mention, mentionData.data]);
  const mentionOpen = mention !== null && mentionClosedAt !== mention.start && mentionData.isSuccess;

  if (!c.can.reply && !c.can.note) return block ? <p className="border-t border-line bg-surface px-4 py-3 text-[13px] text-muted">{block}</p> : null;

  const submit = (): void => {
    if ((!trimmed && !pendingAttachment) || send.isPending || !canWrite || pending.length > 0) return;
    const caption = trimmed || undefined;
    const attachmentId = pendingAttachment?.id ?? null;
    const savedText = trimmed;
    const savedAttachment = pendingAttachment;
    setText('');
    setCaret(0);
    setPendingAttachment(null);
    ref.current?.focus();
    if (attachmentId) {
      (media as ReturnType<typeof useSendMedia>).mutate({ attachment_id: attachmentId, caption }, { onError: () => { setText((cur) => (cur === '' ? savedText : cur)); setPendingAttachment(savedAttachment); } });
    } else if (noteMode) {
      const mentions = mentionIdsIn(trimmed, picked);
      note.mutate({ text: trimmed, ...(mentions.length > 0 ? { mentions } : {}) }, { onError: () => setText((cur) => (cur === '' ? trimmed : cur)) });
      setPicked([]);
    } else {
      reply.mutate(trimmed, { onError: () => setText((cur) => (cur === '' ? trimmed : cur)) });
    }
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
    // El cursor solo se mueve si el texto sigue siendo el que se acaba de armar (si ya siguió escribiendo, moverlo mezclaría lo escrito)
    requestAnimationFrame(() => {
      ref.current?.focus();
      if (ref.current && ref.current.value === next) ref.current.setSelectionRange(at, at);
    });
  };

  /** Pone «@Nombre » en lugar de lo escrito tras la «@» y recuerda a quién se eligió. Quien aún no ve la conversación no se puede elegir (mencionar no da acceso). */
  const insertMention = (o: MentionOption): void => {
    if (!mention || !o.can_view) return;
    const label = `@${o.name} `;
    const next = `${text.slice(0, mention.start)}${label}${text.slice(caret)}`.slice(0, MAX);
    const at = Math.min(mention.start + label.length, MAX);
    setText(next);
    setCaret(at);
    setActive(0);
    setPicked((cur) => (cur.some((p) => p.id === o.id) ? cur : [...cur, { id: o.id, name: o.name }]));
    if (send.isError) send.reset();
    requestAnimationFrame(() => {
      ref.current?.focus();
      if (ref.current && ref.current.value === next) ref.current.setSelectionRange(at, at);
    });
  };

  /** Pone el emoji donde está el cursor (o al final) y deja el cursor justo después. */
  const addEmoji = (emoji: string): void => {
    const at = Math.min(ref.current?.selectionStart ?? text.length, text.length);
    const next = `${text.slice(0, at)}${emoji}${text.slice(at)}`;
    if (next.length > MAX) return;
    const after = at + emoji.length;
    setText(next);
    setCaret(after);
    requestAnimationFrame(() => {
      ref.current?.focus();
      if (ref.current && ref.current.value === next) ref.current.setSelectionRange(after, after);
    });
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    setText(e.target.value);
    setCaret(e.target.selectionStart);
    setActive(0);
    setClosedAt(null);
    setMentionClosedAt(null);
    if (send.isError) send.reset();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (emojis && e.key === 'Escape') {
      e.preventDefault();
      setEmojis(false);
      return;
    }
    if (mentionOpen && people.length > 0 && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : people.length - 1)) % people.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(people[Math.min(active, people.length - 1)]!);
        return;
      }
    }
    if (mentionOpen && e.key === 'Escape' && mention) {
      e.preventDefault();
      setMentionClosedAt(mention.start);
      return;
    }
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
    if (e.key === 'Enter' && !e.shiftKey && !mobile && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={`grid gap-2 border-t border-line px-3 ${mobile ? 'pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2.5' : 'py-2.5'} ${noteMode ? 'bg-warn-soft' : 'bg-surface'}`}>
      {block ? <p role="status" className="text-[12.5px] text-muted">{block}</p> : null}
      {mobile && noteMode && c.can.note ? (
        <p role="status" className="flex items-center gap-2 text-[12.5px] font-semibold text-warn">
          <span className="min-w-0 flex-1">Nota interna · solo la ve tu equipo</span>
          {block === null ? <button type="button" onClick={() => setMode('reply')} className="min-h-11 rounded-full border border-warn px-3 text-[12.5px] font-semibold text-warn">Volver a responder</button> : null}
        </p>
      ) : null}
      {c.can.reply && !mobile ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {c.can.note ? (
        <div role="group" aria-label="Qué vas a escribir" className="flex gap-1.5">
          <button type="button" aria-pressed={mode === 'reply' && block === null} disabled={block !== null} onClick={() => setMode('reply')} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold disabled:opacity-50 ${mode === 'reply' && block === null ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>Responder</button>
          <button type="button" aria-pressed={noteMode} onClick={() => setMode('note')} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold ${noteMode ? 'border-warn bg-warn-soft text-warn' : 'border-line text-muted hover:text-fg'}`}>Nota interna</button>
        </div>
          ) : null}
          {c.channel.kind === 'ghl' || c.channel.kind === 'qr' ? null : <button type="button" onClick={() => setPicker(true)} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold ${c.window.open ? 'border-line text-muted hover:text-fg' : 'border-accent bg-accent text-accent-ink'}`}>Plantillas</button>}
          <button type="button" onClick={() => setManage(true)} className="rounded-full border border-line px-3 py-1 text-[12.5px] font-semibold text-muted hover:text-fg">Respuestas rápidas</button>
        </div>
      ) : null}
      {picker ? <TemplatePicker c={c} onClose={() => setPicker(false)} /> : null}
      {manage ? <QuickRepliesDialog onClose={() => setManage(false)} /> : null}
      {scheduling ? <ScheduleDialog c={c} text={trimmed} onClose={() => setScheduling(false)} onDone={() => { setText(''); setCaret(0); }} /> : null}
      {attaching ? <AttachmentPicker conversationId={c.id} onClose={() => setAttaching(false)} onPicked={(a) => { setPendingAttachment({ id: a.id, filename: a.filename ?? 'archivo', kind: a.kind }); setAttaching(false); }} /> : null}
      {pendingAttachment ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12.5px]">
          <span className="truncate">📎 {kindLabel(pendingAttachment.kind)}</span>
          <button type="button" onClick={() => setPendingAttachment(null)} className="ml-auto text-muted hover:text-fg">Quitar</button>
        </div>
      ) : null}
      {voice.recording ? (
        <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-lg border border-crit bg-crit-soft px-3 py-2 text-[13px] font-semibold text-crit">
          <span aria-hidden="true" className="size-2.5 animate-pulse rounded-full bg-crit" />
          Grabando {mmss(voice.seconds)}
          <span className="ml-auto flex gap-2">
            <IconButton label="Cancelar la grabación" onClick={voice.cancel}><XIcon /></IconButton>
            <IconButton label="Detener y adjuntar la nota de voz" danger onClick={voice.stop}><StopIcon /></IconButton>
          </span>
        </div>
      ) : null}
      {upload.isPending ? <p role="status" className="text-[12.5px] text-muted">Subiendo la nota de voz…</p> : null}
      {voice.error || voiceError ? <Alert>{voice.error ?? voiceError}</Alert> : null}
      {send.isError ? <Alert>{friendlyError(send.error, noteMode ? 'No pudimos guardar la nota.' : pendingAttachment ? 'No pudimos enviar el archivo.' : 'No pudimos enviar el mensaje.')}</Alert> : null}
      {pending.length > 0 ? <Alert kind="info">Falta completar {pending.join(', ')}: reemplázalo con el dato real antes de enviar.</Alert> : null}
      <div className="relative flex items-end gap-2">
        {mentionOpen ? (
          <div className="absolute inset-x-0 bottom-full z-10 mb-1.5 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow)]">
            {people.length > 0 ? (
              <ul id={`${listId}-people`} role="listbox" aria-label="Personas a mencionar" className="grid gap-0.5">
                {people.map((o, i) => (
                  <li
                    key={o.id}
                    id={`${listId}-p${i}`}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={!o.can_view}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertMention(o)}
                    onMouseEnter={() => setActive(i)}
                    className={`grid gap-0.5 rounded-lg px-2.5 py-1.5 text-left ${o.can_view ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'} ${i === active ? 'bg-accent-soft' : o.can_view ? 'hover:bg-surface2' : ''}`}
                  >
                    <b className="text-[13px]">@{o.name}</b>
                    {o.can_view ? null : <span className="text-[12px] text-muted">No ve esta conversación: compártela primero</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status" className="px-2.5 py-2 text-[12.5px] text-muted">{mentionData.data && mentionData.data.items.length === 0 ? 'No hay otras personas en el equipo a quienes mencionar.' : `Nadie del equipo se llama «${mention?.query ?? ''}».`}</p>
            )}
          </div>
        ) : null}
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
        {mobile ? <IconButton label="Más opciones" onClick={() => setSheet(true)}><Icon name="plus" /></IconButton> : null}
        <textarea
          ref={ref}
          rows={mobile ? 1 : 2}
          value={text}
          maxLength={MAX}
          disabled={!canWrite}
          aria-label={noteMode ? 'Nota interna' : 'Mensaje'}
          {...(open && options.length > 0 ? { 'aria-controls': listId, 'aria-activedescendant': `${listId}-${Math.min(active, options.length - 1)}`, 'aria-expanded': true } : {})}
          {...(mentionOpen && people.length > 0 ? { 'aria-controls': `${listId}-people`, 'aria-activedescendant': `${listId}-p${Math.min(active, people.length - 1)}`, 'aria-expanded': true } : {})}
          placeholder={mobile ? (noteMode ? 'Nota interna' : pendingAttachment ? 'Pie del archivo' : 'Mensaje') : noteMode ? 'Nota interna: solo la ve tu equipo. Escribe «@» para mencionar a alguien' : pendingAttachment ? 'Pie del archivo (opcional)' : 'Escribe un mensaje o «/» para una respuesta rápida'}
          onChange={onChange}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
          className={`min-h-[44px] min-w-0 flex-1 resize-none rounded-[14px] border border-line-strong bg-surface px-3.5 py-2.5 text-[14px] placeholder:text-muted disabled:opacity-60 ${mobile ? 'max-h-[132px] overflow-y-auto' : 'max-h-40'}`}
        />
        {mobile ? (
          <>
            <div className="relative">
              <IconButton label="Emojis" pressed={emojis} disabled={!canWrite} onClick={() => setEmojis((v) => !v)}><SmileIcon /></IconButton>
              {emojis ? <EmojiPicker onPick={addEmoji} onClose={() => { setEmojis(false); ref.current?.focus(); }} /> : null}
            </div>
            {mobile && !noteMode && c.can.reply && c.channel.kind !== 'ghl' && !trimmed && !pendingAttachment ? (
              <IconButton label="Grabar nota de voz" disabled={!!block || voice.recording || upload.isPending} onClick={() => void voice.start()}><MicIcon /></IconButton>
            ) : (
              <button
                type="button"
                aria-label={noteMode ? 'Guardar nota' : pendingAttachment ? 'Enviar archivo' : 'Enviar'}
                title={noteMode ? 'Guardar nota' : pendingAttachment ? 'Enviar archivo' : 'Enviar'}
                aria-busy={send.isPending || undefined}
                disabled={send.isPending || (!trimmed && !pendingAttachment) || !canWrite || pending.length > 0}
                onClick={submit}
                className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-accent-ink disabled:opacity-50"
              >
                <Icon name="send" size={20} />
              </button>
            )}
          </>
        ) : (
          <>
          <div className="relative">
            <IconButton label="Emojis" pressed={emojis} disabled={!canWrite} onClick={() => setEmojis((v) => !v)}><SmileIcon /></IconButton>
            {emojis ? <EmojiPicker onPick={addEmoji} onClose={() => { setEmojis(false); ref.current?.focus(); }} /> : null}
          </div>
          {!noteMode && c.can.reply && c.channel.kind !== 'ghl' ? <IconButton label="Adjuntar archivo" disabled={!!block || !!pendingAttachment || voice.recording} onClick={() => setAttaching(true)}><ClipIcon /></IconButton> : null}
          {!noteMode && c.can.reply && c.channel.kind !== 'ghl' ? <IconButton label="Grabar nota de voz" disabled={!!block || !!pendingAttachment || voice.recording || upload.isPending} onClick={() => void voice.start()}><MicIcon /></IconButton> : null}
          {!noteMode && c.can.reply && c.channel.kind !== 'ghl' && c.window.open && !pendingAttachment ? <Button aria-label="Programar mensaje" disabled={!trimmed || pending.length > 0} onClick={() => setScheduling(true)}>Programar</Button> : null}
          <Button variant="primary" loading={send.isPending} disabled={(!trimmed && !pendingAttachment) || !canWrite || pending.length > 0} onClick={submit}>{noteMode ? 'Guardar nota' : pendingAttachment ? 'Enviar archivo' : 'Enviar'}</Button>

          </>
        )}
      </div>
      {sheet ? (
        <Drawer label="Más opciones del mensaje" placement="bottom" onClose={() => setSheet(false)}>
          <div className="grid w-full gap-1 p-3">
            <div className="flex items-center justify-between gap-2 px-1 pb-1">
              <h3 className="text-[15px] font-bold">Más opciones</h3>
              <button type="button" aria-label="Cerrar las opciones" onClick={() => setSheet(false)} className="grid size-11 place-items-center rounded-full text-muted hover:bg-surface2"><Icon name="close" /></button>
            </div>
            {!noteMode && c.can.reply && c.channel.kind !== 'ghl' ? <SheetButton icon="plus" disabled={!!block || !!pendingAttachment || voice.recording} onClick={() => { setSheet(false); setAttaching(true); }}>Adjuntar archivo</SheetButton> : null}
            {c.can.reply && c.channel.kind !== 'ghl' && c.channel.kind !== 'qr' ? <SheetButton icon="form" {...(c.window.open ? {} : { primary: true, hint: 'La ventana de 24 h está cerrada: solo puedes escribir con una plantilla' })} onClick={() => { setSheet(false); setPicker(true); }}>Plantillas</SheetButton> : null}
            {c.can.reply ? <SheetButton icon="bolt" onClick={() => { setSheet(false); setManage(true); }}>Respuestas rápidas</SheetButton> : null}
            {!noteMode && c.can.reply && c.channel.kind !== 'ghl' && c.window.open && !pendingAttachment ? <SheetButton icon="clock" disabled={!trimmed || pending.length > 0} hint={trimmed ? undefined : 'Escribe el mensaje primero'} onClick={() => { setSheet(false); setScheduling(true); }}>Programar mensaje</SheetButton> : null}
            {c.can.note ? (
              noteMode && block === null ? <SheetButton icon="reset" onClick={() => { setSheet(false); setMode('reply'); }}>Volver a responder al cliente</SheetButton> : block === null ? <SheetButton icon="list" onClick={() => { setSheet(false); setMode('note'); }}>Escribir una nota interna</SheetButton> : null
            ) : null}
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}
