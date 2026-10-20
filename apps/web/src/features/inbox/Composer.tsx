import { useRef, useState, type KeyboardEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Conversation } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';
import { TemplatePicker } from './TemplatePicker';
import { useSendNote, useSendReply } from './useInbox';

const MAX = 4096;

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

/**
 * Redactor del hilo: «Responder» (sale al cliente por WhatsApp) o «Nota interna» (solo la ve el equipo y nunca sale). Enter envía y Mayús+Enter da un salto de línea.
 * Cuando no se puede escribir al cliente explica por qué; las notas siguen disponibles para quien tenga permiso.
 */
export function Composer({ c }: { c: Conversation }) {
  const reply = useSendReply(c.id);
  const note = useSendNote(c.id);
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const block = replyBlock(c);
  const noteMode = mode === 'note' || block !== null;
  const canWrite = noteMode ? c.can.note : true;
  const send = noteMode ? note : reply;
  const trimmed = text.trim();

  if (!c.can.reply && !c.can.note) return block ? <p className="border-t border-line bg-surface px-4 py-3 text-[13px] text-muted">{block}</p> : null;

  const submit = (): void => {
    if (!trimmed || send.isPending || !canWrite) return;
    // El texto se limpia al enviar (no al terminar de refrescar la lista): si no, lo que la persona ya empezó a escribir después —una nota, el siguiente mensaje— se borraría
    // cuando llegue la respuesta. Si el envío falla, el texto vuelve, salvo que ya haya escrito otra cosa.
    setText('');
    ref.current?.focus();
    send.mutate(trimmed, { onError: () => setText((cur) => (cur === '' ? trimmed : cur)) });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
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
        </div>
      ) : null}
      {picker ? <TemplatePicker c={c} onClose={() => setPicker(false)} /> : null}
      {send.isError ? <Alert>{friendlyError(send.error, noteMode ? 'No pudimos guardar la nota.' : 'No pudimos enviar el mensaje.')}</Alert> : null}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={2}
          value={text}
          maxLength={MAX}
          disabled={!canWrite}
          aria-label={noteMode ? 'Nota interna' : 'Mensaje'}
          placeholder={noteMode ? 'Nota interna: solo la ve tu equipo' : 'Escribe un mensaje'}
          onChange={(e) => { setText(e.target.value); if (send.isError) send.reset(); }}
          onKeyDown={onKey}
          className="max-h-40 min-h-[44px] flex-1 resize-none rounded-[14px] border border-line bg-surface px-3.5 py-2.5 text-[14px] placeholder:text-muted/70 disabled:opacity-60"
        />
        <Button variant="primary" loading={send.isPending} disabled={!trimmed || !canWrite} onClick={submit}>{noteMode ? 'Guardar nota' : 'Enviar'}</Button>
      </div>
    </div>
  );
}
