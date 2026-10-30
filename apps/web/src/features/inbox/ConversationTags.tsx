import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { Contact, ContactTag, Conversation } from '../../lib/types';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { useCreateTag, useTags } from '../tags/useTags';

const DEFAULT_COLOR = '#6a44f2';

/** Una etiqueta como chip de color (las del sistema se distinguen en el diálogo, no aquí). */
export function TagChip({ t }: { t: ContactTag }) {
  return <span className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold text-white" style={{ backgroundColor: t.color }}>{t.name}</span>;
}

/** Cambia el conjunto de etiquetas PERSONALIZADAS del contacto (las del sistema no se tocan) y refresca la conversación y el listado. */
function useSetContactTags(c: Conversation) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagIds: string[]) => api<Contact>(`/contacts/${c.contact.id}`, { method: 'PATCH', body: { tag_ids: tagIds } }),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['conversation', c.id] }), qc.invalidateQueries({ queryKey: ['conversations'] }), qc.invalidateQueries({ queryKey: ['contacts'] }), qc.invalidateQueries({ queryKey: ['contact', c.contact.id] })]),
  });
}

/**
 * Etiquetas del contacto desde el chat (M5.8, ADR-45/46): las ve, agrega y quita, y crea una nueva sin salir. Las del sistema (Lead, Cita agendada, Venta) solo las pone el
 * servidor: aquí se ven pero no se mueven. Crear exige `tags.manage` (el servidor lo informa en `access.manage`); asignar sigue las reglas de edición de contactos, así que
 * si la persona no puede, el servidor responde y se le dice.
 */
function TagsDialog({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const tags = useTags();
  const setTags = useSetContactTags(c);
  const create = useCreateTag();
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [error, setError] = useState<string>();
  const mine = new Set(c.tags.filter((t) => !t.is_system).map((t) => t.id));
  const custom = (tags.data?.items ?? []).filter((t) => !t.is_system);
  const canCreate = tags.data?.access.manage === true;

  const toggle = (t: ContactTag): void => {
    setError(undefined);
    const next = new Set(mine);
    if (next.has(t.id)) next.delete(t.id);
    else next.add(t.id);
    setTags.mutate([...next], { onError: (e) => setError(friendlyError(e, 'No pudimos cambiar las etiquetas.')) });
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError('Escribe el nombre de la etiqueta');
    setError(undefined);
    create.mutate({ name: n, color }, {
      onSuccess: (t) => { setName(''); setTags.mutate([...mine, t.id], { onError: (err) => setError(friendlyError(err, 'La etiqueta se creó, pero no pudimos agregarla al contacto.')) }); },
      onError: (err) => setError(friendlyError(err, 'No pudimos crear la etiqueta.')),
    });
  };

  return (
    <Modal title={`Etiquetas de ${c.contact.name}`} onClose={onClose}>
      {tags.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando etiquetas" /></div> : null}
      {tags.isError ? <Alert>{friendlyError(tags.error, 'No pudimos cargar las etiquetas.')}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      {c.tags.some((t) => t.is_system) ? (
        <div className="grid gap-1">
          <span className="text-[12.5px] font-semibold text-muted">Del sistema (las pone el sistema)</span>
          <div className="flex flex-wrap gap-1.5">{c.tags.filter((t) => t.is_system).map((t) => <Pill key={t.id} kind="muted">{t.name}</Pill>)}</div>
        </div>
      ) : null}
      {tags.isSuccess ? (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-[12.5px] font-semibold text-muted">Personalizadas</legend>
          {custom.length === 0 ? <p className="text-[13px] text-muted">{canCreate ? 'Aún no hay etiquetas. Crea la primera abajo.' : 'Aún no hay etiquetas personalizadas. Pide a un administrador que cree alguna.'}</p> : null}
          <ul className="grid max-h-56 gap-0.5 overflow-y-auto">
            {custom.map((t) => (
              <li key={t.id}>
                <label className="flex min-h-[40px] cursor-pointer items-center gap-2.5 rounded-lg px-2 hover:bg-surface2">
                  <input type="checkbox" checked={mine.has(t.id)} disabled={setTags.isPending} onChange={() => toggle(t)} className="size-4" />
                  <span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: t.color }} />
                  <span className="text-[14px] font-semibold">{t.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      {canCreate ? (
        <form onSubmit={submit} className="grid gap-2 border-t border-line pt-3" aria-label="Crear etiqueta">
          <span className="text-[12.5px] font-semibold text-muted">Crear una etiqueta nueva</span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <Field label="Nombre">{(p) => <Input {...p} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Color">{(p) => <input {...p} type="color" value={color} onChange={(e) => setColor(e.target.value.toLowerCase())} className="h-11 w-16 cursor-pointer rounded-[10px] border border-line bg-surface p-1" />}</Field>
          </div>
          <Button type="submit" loading={create.isPending}>Crear y agregar</Button>
        </form>
      ) : null}
      <div className="flex justify-end"><Button onClick={onClose}>Listo</Button></div>
    </Modal>
  );
}

/** Las etiquetas del contacto como chips y el botón «Etiquetas» que abre el diálogo para cambiarlas. */
export function ConversationTags({ c }: { c: Conversation }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {c.tags.map((t) => <TagChip key={t.id} t={t} />)}
      <button type="button" onClick={() => setOpen(true)} aria-label="Etiquetas del contacto" className="rounded-full border border-line px-2.5 py-0.5 text-[12px] font-semibold text-muted hover:text-fg">+ Etiquetas</button>
      {open ? <TagsDialog c={c} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
