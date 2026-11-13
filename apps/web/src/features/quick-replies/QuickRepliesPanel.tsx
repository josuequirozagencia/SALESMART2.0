import { useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { QuickReply } from '../../lib/types';
import { useSession } from '../../lib/session';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { useCustomFields } from '../custom-fields/useCustomFields';
import { previewParts, sampleValues, SAMPLE_CONTACT, splitVariables } from './preview';
import { useCreateQuickReply, useDeleteQuickReply, useQuickReplies, useUpdateQuickReply } from './useQuickReplies';

const MAX = 4096;
const SMALL = '!px-3 !py-1.5 !text-[12.5px]';

/** Cómo se escribe una variable en el texto. */
const token = (key: string): string => `{{${key}}}`;

/** El texto con las variables reemplazadas por valores de ejemplo, en color; lo que no se puede resolver, marcado (v13 S6, como el prototipo). */
function Preview({ body }: { body: string }) {
  const { state } = useSession();
  const me = state.status === 'authed' ? state.me : null;
  const values = sampleValues({ firstName: (me?.user.full_name ?? me?.user.email ?? 'Tú').split(/\s+/)[0] ?? 'Tú', organization: me?.organization.name ?? 'Tu empresa' });
  const parts = previewParts(body, values);
  const missing = parts.some((p) => p.kind === 'missing');
  return (
    <div className="grid gap-1.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">Vista previa con {SAMPLE_CONTACT}</span>
      <div aria-label="Vista previa del mensaje" role="group" className="whitespace-pre-wrap break-words rounded-lg bg-surface2 p-2.5 text-[12.5px]">
        {parts.length === 0 ? <span className="text-muted">Escribe el mensaje para ver cómo queda.</span> : parts.map((p, i) => (p.kind === 'text' ? <span key={i}>{p.text}</span> : p.kind === 'value' ? <b key={i} className="font-semibold text-accent">{p.text}</b> : <mark key={i} className="rounded bg-warn-soft px-1 text-warn">{p.text}</mark>))}
      </div>
      {missing ? <span className="text-[12px] text-muted">Lo marcado depende de cada contacto: si no tiene ese dato, lo verás para completarlo antes de enviar.</span> : null}
    </div>
  );
}

/** Alta o cambio de una respuesta: atajo, texto con variables que se insertan con un clic y, si la persona puede, compartirla con toda la empresa. */
function QuickReplyForm({ reply, canShare, variables, onClose }: { reply?: QuickReply; canShare: boolean; variables: Array<{ key: string; label: string }>; onClose: () => void }) {
  const create = useCreateQuickReply();
  const update = useUpdateQuickReply();
  const fields = useCustomFields().data?.items ?? [];
  const [shortcut, setShortcut] = useState(reply?.shortcut ?? '');
  const [body, setBody] = useState(reply?.body ?? '');
  const [shared, setShared] = useState(reply?.shared ?? false);
  const [errors, setErrors] = useState<{ shortcut?: string; body?: string }>({});
  const [error, setError] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const pending = create.isPending || update.isPending;
  const all = [...variables, ...fields.map((f) => ({ key: `contact.${f.key}`, label: f.name }))];

  /** Inserta la variable donde está el cursor (o al final). */
  const insert = (key: string): void => {
    const el = area.current;
    const at = token(key);
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${at}${body.slice(end)}`;
    if (next.length > MAX) return;
    setBody(next);
    // El cursor solo se mueve si el texto sigue siendo el que se acaba de armar: si la persona ya siguió escribiendo, moverlo mezclaría lo que escribió
    requestAnimationFrame(() => {
      el?.focus();
      if (el && el.value === next) el.setSelectionRange(start + at.length, start + at.length);
    });
  };

  function submit(): void {
    setError(undefined);
    const clean = shortcut.trim().replace(/^\/+/, '').toLowerCase();
    const next: typeof errors = {};
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(clean)) next.shortcut = 'Usa letras sin tilde, números, guion o guion bajo (máximo 32)';
    if (body.trim() === '') next.body = 'Escribe el mensaje';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const onError = (e: unknown): void => {
      if (e instanceof ApiError && e.status === 400 && e.details.length > 0) {
        const found: typeof errors = {};
        for (const d of e.details) {
          if (d.path === 'body') found.body = d.message;
          else if (d.path === 'shortcut') found.shortcut = d.message;
        }
        if (Object.keys(found).length > 0) {
          setErrors(found);
          return;
        }
      }
      if (e instanceof ApiError && e.code === 'QUICK_REPLY_EXISTS') {
        setErrors({ shortcut: e.message });
        return;
      }
      setError(friendlyError(e, 'No pudimos guardar la respuesta.'));
    };
    if (reply) update.mutate({ id: reply.id, input: { shortcut: clean, body: body.trim(), shared } }, { onSuccess: onClose, onError });
    else create.mutate({ shortcut: clean, body: body.trim(), shared }, { onSuccess: onClose, onError });
  }

  return (
    <Modal title={reply ? `Cambiar /${reply.shortcut}` : 'Nueva respuesta rápida'} onClose={onClose} wide>
      <Field label="Atajo" required error={errors.shortcut} hint="Lo que escribes después de la barra para usarla, por ejemplo «precios».">
        {(p) => (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="text-[15px] font-bold text-muted">/</span>
            <Input {...p} value={shortcut} maxLength={33} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(e) => setShortcut(e.target.value)} />
          </span>
        )}
      </Field>
      <Field label="Mensaje" required error={errors.body}>
        {(p) => (
          <textarea {...p} ref={area} rows={5} value={body} maxLength={MAX} onChange={(e) => setBody(e.target.value)} className="min-h-[110px] w-full resize-y rounded-[10px] border border-line bg-surface px-3 py-[11px] text-[14px] font-normal aria-[invalid=true]:border-crit" />
        )}
      </Field>
      <div className="grid gap-1.5">
        <span className="text-[12.5px] font-semibold">Insertar un dato que cambia con cada cliente</span>
        <span className="flex flex-wrap gap-1.5">
          {all.map((v) => (
            <button key={v.key} type="button" aria-label={`Insertar ${v.label}`} title={v.label} onClick={() => insert(v.key)} className="rounded-[5px] border border-line bg-surface px-1.5 py-0.5 font-mono text-[11.5px] text-fg hover:border-accent hover:text-accent">
              {token(v.key)}
            </button>
          ))}
        </span>
        <span className="text-[12px] text-muted">Se reemplazan al usar la respuesta en una conversación. Si el contacto no tiene el dato, lo verás marcado para completarlo antes de enviar.</span>
      </div>
      <Preview body={body} />
      {canShare ? (
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="mt-0.5 size-4" />
          <span><b className="font-semibold">Compartir con toda la empresa.</b> <span className="text-muted">Si no, solo la ves y usas tú.</span></span>
        </label>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={pending} onClick={submit}>{reply ? 'Guardar cambios' : 'Crear respuesta'}</Button>
      </div>
    </Modal>
  );
}

/** Confirmación al borrar: la respuesta deja de poder usarse. */
function ConfirmDelete({ reply, onClose }: { reply: QuickReply; onClose: () => void }) {
  const del = useDeleteQuickReply();
  return (
    <Modal title={`Borrar /${reply.shortcut}`} onClose={onClose}>
      <p className="text-[13.5px]">Dejará de aparecer al escribir «/{reply.shortcut}»{reply.shared ? ' para todo el equipo' : ''}. Los mensajes ya enviados no cambian.</p>
      {del.isError ? <Alert>{friendlyError(del.error, 'No pudimos borrar la respuesta.')}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="danger" loading={del.isPending} onClick={() => del.mutate(reply.id, { onSuccess: onClose })}>Borrar</Button>
      </div>
    </Modal>
  );
}

/**
 * Las respuestas rápidas (M5.6b, ADR-50): se escriben una vez y se usan con «/atajo» en el redactor. Cada persona maneja las suyas; el administrador puede compartirlas con toda la empresa.
 * Se usa en Configuración (administrador) y dentro del Inbox (quien responde, que no tiene Configuración).
 */
export function QuickRepliesPanel() {
  const q = useQuickReplies();
  const [editing, setEditing] = useState<QuickReply | 'new'>();
  const [deleting, setDeleting] = useState<QuickReply>();
  const items = q.data?.items ?? [];

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[560px] text-[13.5px] text-muted">
          Mensajes que usas seguido. Escribe <b className="font-mono text-fg">/</b> en una conversación y elige uno. Pueden llevar datos del cliente, como su nombre, que se llenan solos.
        </p>
        {q.isSuccess ? <Button variant="primary" onClick={() => setEditing('new')}>Nueva respuesta</Button> : null}
      </div>
      {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando respuestas rápidas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las respuestas rápidas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && items.length === 0 ? <p className="rounded-2xl border border-dashed border-line p-5 text-center text-[13.5px] text-muted">Aún no tienes respuestas rápidas. Crea la primera con «Nueva respuesta».</p> : null}
      {items.length > 0 ? (
        // v13 S6: como la tabla del prototipo —atajo · mensaje · ámbito · acciones—, con las variables resaltadas en el mensaje; en pantallas angostas cada fila se apila
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div aria-hidden="true" className="hidden grid-cols-[140px_minmax(0,1fr)_110px_150px] gap-3 border-b border-line bg-surface2 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted md:grid">
            <span>Atajo</span><span>Mensaje</span><span>Ámbito</span><span className="text-right">Acciones</span>
          </div>
          <ul aria-label="Respuestas rápidas" className="grid divide-y divide-line">
            {items.map((r) => (
              <li key={r.id} className="grid items-start gap-x-3 gap-y-1.5 px-3 py-2.5 md:grid-cols-[140px_minmax(0,1fr)_110px_150px]">
                <span><span className="inline-block rounded-[5px] bg-surface2 px-1.5 py-0.5 font-mono text-[12px] font-semibold">/{r.shortcut}</span></span>
                <p className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words text-[13px]">
                  {splitVariables(r.body).map((p, i) => (p.variable ? <span key={i} className="font-mono text-[12px] text-accent">{p.text}</span> : <span key={i}>{p.text}</span>))}
                </p>
                <span>{r.shared ? <Pill kind="accent">Compartida</Pill> : <Pill kind="muted">Solo mía</Pill>}</span>
                <span className="flex gap-1.5 md:justify-end">
                  {r.can_edit ? (
                    <>
                      <Button className={SMALL} aria-label={`Cambiar /${r.shortcut}`} onClick={() => setEditing(r)}>Cambiar</Button>
                      <Button className={SMALL} aria-label={`Borrar /${r.shortcut}`} onClick={() => setDeleting(r)}>Borrar</Button>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {editing && q.data ? <QuickReplyForm key={editing === 'new' ? 'new' : editing.id} {...(editing === 'new' ? {} : { reply: editing })} canShare={q.data.access.share} variables={q.data.built_in_variables} onClose={() => setEditing(undefined)} /> : null}
      {deleting ? <ConfirmDelete reply={deleting} onClose={() => setDeleting(undefined)} /> : null}
    </div>
  );
}

/** El panel dentro de una ventana, para quien responde conversaciones y no tiene Configuración. */
export function QuickRepliesDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Respuestas rápidas" onClose={onClose} wide>
      <div className="max-h-[65vh] overflow-y-auto pr-1"><QuickRepliesPanel /></div>
      <div className="flex justify-end"><Button onClick={onClose}>Cerrar</Button></div>
    </Modal>
  );
}
