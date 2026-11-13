import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { Contact, ContactTag, Conversation } from '../../lib/types';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Icon } from '../../ui/Icon';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { TagBadge } from '../../ui/TagBadge';
import { useCreateTag, useTags } from '../tags/useTags';

const DEFAULT_COLOR = '#4f46e5';

/** Una etiqueta como chip de color (las del sistema se distinguen en el diálogo, no aquí). */
export function TagChip({ t }: { t: ContactTag }) {
  return <TagBadge name={t.name} color={t.color} />;
}

/** Cambia el conjunto de etiquetas PERSONALIZADAS del contacto (las del sistema no se tocan) y refresca la conversación y el listado. */
function useSetContactTags(c: Conversation) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagIds: string[]) => api<Contact>(`/contacts/${c.contact.id}`, { method: 'PATCH', body: { tag_ids: tagIds } }),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['conversation', c.id] }), qc.invalidateQueries({ queryKey: ['conversations'] }), qc.invalidateQueries({ queryKey: ['contacts'] }), qc.invalidateQueries({ queryKey: ['contact', c.contact.id] })]),
  });
}

/** Con más etiquetas que esto, el editor compacto ofrece un buscador. */
const SEARCH_FROM = 8;

/**
 * El editor de etiquetas: las del sistema solo se ven; las personalizadas se marcan y desmarcan. `compact` (popover del chat móvil, v13 S1.2): con buscador si hay más de 8 y la creación
 * escondida tras «Crear etiqueta». Crear exige `tags.manage` (el servidor lo informa en `access.manage`); asignar sigue las reglas de edición de contactos, así que si la persona no puede,
 * el servidor responde y se le dice.
 */
function TagsEditor({ c, compact = false }: { c: Conversation; compact?: boolean }) {
  const tags = useTags();
  const setTags = useSetContactTags(c);
  const create = useCreateTag();
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(!compact);
  const mine = new Set(c.tags.filter((t) => !t.is_system).map((t) => t.id));
  const custom = (tags.data?.items ?? []).filter((t) => !t.is_system);
  const canCreate = tags.data?.access.manage === true;
  const searchable = compact && custom.length > SEARCH_FROM;
  const shown = searchable && query.trim() ? custom.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase())) : custom;

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
    <>
      {tags.isPending ? <div className="grid place-items-center py-6 text-muted"><Spinner label="Cargando etiquetas" /></div> : null}
      {tags.isError ? <Alert>{friendlyError(tags.error, 'No pudimos cargar las etiquetas.')}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      {c.tags.some((t) => t.is_system) ? (
        <div className="grid gap-1">
          <span className="text-[12.5px] font-semibold text-muted">Del sistema (solo lectura: las pone el sistema)</span>
          <div className="flex flex-wrap gap-1.5">{c.tags.filter((t) => t.is_system).map((t) => <Pill key={t.id} kind="muted">{t.name}</Pill>)}</div>
        </div>
      ) : null}
      {tags.isSuccess ? (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-[12.5px] font-semibold text-muted">Personalizadas</legend>
          {searchable ? <input type="search" aria-label="Buscar etiquetas" placeholder="Buscar etiqueta" value={query} onChange={(e) => setQuery(e.target.value)} className="min-h-11 rounded-[10px] border border-line-strong bg-surface px-3 text-[14px]" /> : null}
          {custom.length === 0 ? <p className="text-[13px] text-muted">{canCreate ? 'Aún no hay etiquetas. Crea la primera abajo.' : 'Aún no hay etiquetas personalizadas. Pide a un administrador que cree alguna.'}</p> : null}
          {custom.length > 0 && shown.length === 0 ? <p role="status" className="text-[13px] text-muted">Ninguna etiqueta se llama «{query.trim()}».</p> : null}
          <ul className={`grid gap-0.5 overflow-y-auto ${compact ? 'max-h-64' : 'max-h-56'}`}>
            {shown.map((t) => (
              <li key={t.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2 hover:bg-surface2">
                  <input type="checkbox" checked={mine.has(t.id)} disabled={setTags.isPending} onChange={() => toggle(t)} className="size-4" />
                  <span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: t.color }} />
                  <span className="text-[14px] font-semibold">{t.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      {canCreate && compact && !creating ? <Button onClick={() => setCreating(true)}>Crear etiqueta</Button> : null}
      {canCreate && creating ? (
        <form onSubmit={submit} className="grid gap-2 border-t border-line pt-3" aria-label="Crear etiqueta">
          <span className="text-[12.5px] font-semibold text-muted">Crear una etiqueta nueva</span>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <Field label="Nombre">{(p) => <Input {...p} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Color">{(p) => <input {...p} type="color" value={color} onChange={(e) => setColor(e.target.value.toLowerCase())} className="h-11 w-16 cursor-pointer rounded-[10px] border border-line bg-surface p-1" />}</Field>
          </div>
          <Button type="submit" loading={create.isPending}>Crear y agregar</Button>
        </form>
      ) : null}
    </>
  );
}

/** Etiquetas del contacto desde el chat (M5.8, ADR-45/46) en una ventana: ver, agregar y quitar, y crear una nueva sin salir. */
function TagsDialog({ c, onClose }: { c: Conversation; onClose: () => void }) {
  return (
    <Modal title={`Etiquetas de ${c.contact.name}`} onClose={onClose}>
      <TagsEditor c={c} />
      <div className="flex justify-end"><Button onClick={onClose}>Listo</Button></div>
    </Modal>
  );
}

/**
 * El icono de etiquetas de la cabecera del chat móvil (v13 S1.2): abre el popover «Etiquetas de la conversación». Un punto sobre el icono avisa que el contacto tiene etiquetas. Se cierra con Esc
 * (el foco vuelve al icono) o al tocar fuera; el panel recibe el foco al abrir. Las etiquetas del sistema solo se muestran.
 */
export function TagsPopoverButton({ c }: { c: Conversation }) {
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (): void => { setOpen(false); button.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onDown = (e: Event): void => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
    };
    // Esc cierra aunque el foco ya no esté dentro del panel (al marcar una etiqueta la lista se vuelve a pintar y el foco se pierde)
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={c.tags.length > 0 ? `Etiquetas de la conversación (${c.tags.length})` : 'Etiquetas de la conversación'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => { setTop((button.current?.getBoundingClientRect().bottom ?? 56) + 4); setOpen((v) => !v); }}
        className={`relative grid size-11 shrink-0 place-items-center rounded-full hover:bg-surface2 ${open ? 'bg-accent-soft text-accent' : 'text-muted'}`}
      >
        <Icon name="tag" size={22} />
        {c.tags.length > 0 ? <span aria-hidden="true" className="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-accent" /> : null}
      </button>
      {open ? (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label="Etiquetas de la conversación"
          tabIndex={-1}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}
          style={{ top }}
          className="fixed inset-x-3 z-40 ml-auto grid max-h-[min(70dvh,480px)] max-w-sm gap-3 overflow-y-auto rounded-2xl border border-line bg-surface p-3 shadow-[var(--shadow)] focus:outline-none"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-bold">Etiquetas de la conversación</h3>
            <button type="button" aria-label="Cerrar las etiquetas" onClick={close} className="grid size-11 place-items-center rounded-full text-muted hover:bg-surface2"><Icon name="close" /></button>
          </div>
          <TagsEditor c={c} compact />
        </div>
      ) : null}
    </>
  );
}

/**
 * Las etiquetas del contacto como chips. Cada etiqueta PERSONALIZADA lleva un × para quitarla (no borra al contacto ni la conversación; se audita y, si estaba enviada a GoHighLevel, se
 * quita allá por el mismo flujo de siempre). Las del sistema (Lead, Cita agendada, Venta) no lo llevan: solo las pone el sistema.
 */
export function RemovableTags({ c }: { c: Conversation }) {
  const setTags = useSetContactTags(c);
  const [error, setError] = useState<string>();
  const remove = (t: ContactTag): void => {
    setError(undefined);
    const next = c.tags.filter((x) => !x.is_system && x.id !== t.id).map((x) => x.id);
    setTags.mutate(next, { onError: (e) => setError(friendlyError(e, 'No pudimos quitar la etiqueta.')) });
  };
  return (
    <>
      {c.tags.map((t) =>
        t.is_system ? (
          <TagChip key={t.id} t={t} />
        ) : (
          <span key={t.id} className="inline-flex items-center gap-0.5">
            <TagChip t={t} />
            <button type="button" aria-label={`Quitar la etiqueta «${t.name}»`} title="Quitar la etiqueta" disabled={setTags.isPending} onClick={() => remove(t)} className="grid size-5 place-items-center rounded-full text-[13px] leading-none text-muted hover:bg-surface2 hover:text-fg disabled:opacity-50 max-md:size-8">×</button>
          </span>
        ),
      )}
      {error ? <span role="alert" className="text-[12px] font-semibold text-crit">{error}</span> : null}
    </>
  );
}

/** Las etiquetas del contacto como chips y el botón «Etiquetas» que abre el diálogo para cambiarlas. */
export function ConversationTags({ c }: { c: Conversation }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <RemovableTags c={c} />
      <button type="button" onClick={() => setOpen(true)} aria-label="Etiquetas del contacto" className="rounded-full border border-line px-2.5 py-0.5 text-[12px] font-semibold text-muted hover:text-fg">+ Etiquetas</button>
      {open ? <TagsDialog c={c} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
