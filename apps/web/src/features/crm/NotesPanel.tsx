import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { shortDateTime } from '../../lib/format';
import type { Note } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { useAddNote, useDeleteNote, useEditNote, useNotes, type NoteTarget } from './useCrm';

const MAX_NOTE = 5000;
const areaCls = 'w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-[13.5px]';

/**
 * Notas internas de un contacto o una empresa (M3.6, ADR-48). Solo las ve el equipo: nunca salen al cliente. Las edita quien las escribió; las borra
 * quien las escribió o el administrador (el servidor lo decide y lo informa en `can_edit` / `can_delete`).
 */
export function NotesPanel({ target, canWrite }: { target: NoteTarget; canWrite: boolean }) {
  const q = useNotes(target);
  const add = useAddNote(target);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const notes = q.data?.pages.flatMap((p) => p.items) ?? [];

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const body = text.trim();
    if (body === '') return setError('Escribe la nota');
    if (body.length > MAX_NOTE) return setError(`Usa como máximo ${MAX_NOTE} caracteres`);
    add.mutate(body, { onSuccess: () => setText(''), onError: (err) => setError(friendlyError(err, 'No pudimos guardar la nota.')) });
  }

  return (
    <section aria-label="Notas" className="grid gap-3">
      <p className="text-[12.5px] text-muted">Notas internas: solo las ve tu equipo, nunca el cliente.</p>
      {canWrite ? (
        <form onSubmit={submit} noValidate className="grid gap-2">
          <label className="grid gap-1 text-[12px] font-semibold">Nueva nota
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={MAX_NOTE} className={`${areaCls} font-normal`} placeholder="Qué pasó, qué prefiere, qué sigue…" />
          </label>
          {error ? <Alert>{error}</Alert> : null}
          <div><Button type="submit" variant="primary" className="!px-4 !py-2 !text-[13px]" loading={add.isPending}>Agregar nota</Button></div>
        </form>
      ) : null}
      {q.isPending ? <div className="grid place-items-center py-4 text-muted"><Spinner label="Cargando notas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las notas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && notes.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">Todavía no hay notas.</p> : null}
      <ul className="grid gap-2">
        {notes.map((n) => <NoteItem key={n.id} note={n} target={target} />)}
      </ul>
      {q.hasNextPage ? <div><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Ver notas anteriores</Button></div> : null}
    </section>
  );
}

function NoteItem({ note, target }: { note: Note; target: NoteTarget }) {
  const edit = useEditNote(target);
  const remove = useDeleteNote(target);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.body);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();

  function save() {
    setError(undefined);
    const body = text.trim();
    if (body === '') return setError('La nota no puede quedar vacía');
    edit.mutate({ id: note.id, body }, { onSuccess: () => setEditing(false), onError: (e) => setError(friendlyError(e, 'No pudimos guardar la nota.')) });
  }

  return (
    <li className="grid gap-1.5 rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span><b className="text-fg">{note.author.name}</b> · {shortDateTime(note.created_at)}{note.edited_at ? ' · editada' : ''}</span>
        {!editing ? (
          <span className="flex items-center gap-2">
            {note.can_edit ? <Button variant="link" aria-label="Editar la nota" onClick={() => { setText(note.body); setEditing(true); }}>Editar</Button> : null}
            {note.can_delete ? (
              confirm ? (
                <span className="flex items-center gap-1.5">¿Borrar?
                  <Button variant="danger" className="!px-2.5 !py-1 !text-[12px]" loading={remove.isPending} onClick={() => remove.mutate(note.id, { onError: (e) => { setConfirm(false); setError(friendlyError(e, 'No pudimos borrar la nota.')); } })}>Sí</Button>
                  <Button className="!px-2.5 !py-1 !text-[12px]" onClick={() => setConfirm(false)}>No</Button>
                </span>
              ) : <Button variant="link" aria-label="Borrar la nota" onClick={() => setConfirm(true)}>Borrar</Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {editing ? (
        <div className="grid gap-2">
          <textarea aria-label="Texto de la nota" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={MAX_NOTE} className={areaCls} />
          <div className="flex gap-2">
            <Button variant="primary" className="!px-3 !py-1.5 !text-[12.5px]" loading={edit.isPending} onClick={save}>Guardar</Button>
            <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => { setEditing(false); setError(undefined); }}>Cancelar</Button>
          </div>
        </div>
      ) : <p className="whitespace-pre-wrap break-words text-[13.5px]">{note.body}</p>}
      {error ? <Alert>{error}</Alert> : null}
    </li>
  );
}
