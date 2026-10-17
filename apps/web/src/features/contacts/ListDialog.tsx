import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { SavedFilters, SavedList } from '../../lib/types';
import { Alert, Button, Field, Input } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useCreateList, useDeleteList, useUpdateList } from './useLists';

export type ListMode = { kind: 'filters' } | { kind: 'selection'; ids: string[] } | { kind: 'edit'; list: SavedList };

/**
 * Alta y edición de una lista (ADR-46). «Con los filtros actuales» crea una lista DINÁMICA (guarda filtros, columnas y orden; se recalcula sola);
 * «con la selección» crea una FIJA con esos contactos. Compartir solo está disponible para quien ve todos los contactos.
 */
export function ListDialog({
  mode,
  filters,
  columns,
  sort,
  canShare,
  onClose,
  onDone,
}: {
  mode: ListMode;
  filters: SavedFilters;
  columns: string[];
  sort: { key: 'created_at' | 'updated_at' | 'name'; order: 'asc' | 'desc' };
  canShare: boolean;
  onClose: () => void;
  /** La lista creada o editada; null si se borró. */
  onDone: (list: SavedList | null) => void;
}) {
  const editing = mode.kind === 'edit' ? mode.list : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [shared, setShared] = useState(editing?.shared ?? false);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const create = useCreateList();
  const update = useUpdateList();
  const remove = useDeleteList();
  const busy = create.isPending || update.isPending;
  const tooMany = mode.kind === 'selection' && mode.ids.length > 500;

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const n = name.trim();
    if (n === '') return setFieldError('Escribe un nombre para la lista');
    if (n.length > 60) return setFieldError('Usa como máximo 60 caracteres');
    setFieldError(undefined);
    const fail = (err: unknown) => setError(friendlyError(err, 'No pudimos guardar la lista.'));
    if (editing) {
      update.mutate({ id: editing.id, patch: { name: n, ...(canShare ? { shared } : {}) } }, { onSuccess: (l) => onDone(l), onError: fail });
      return;
    }
    const base = { name: n, columns, sort, ...(canShare && shared ? { shared: true } : {}) };
    if (mode.kind === 'selection') create.mutate({ ...base, kind: 'fixed', contact_ids: mode.ids }, { onSuccess: (l) => onDone(l), onError: fail });
    else create.mutate({ ...base, kind: 'dynamic', filters }, { onSuccess: (l) => onDone(l), onError: fail });
  }

  const title = editing ? 'Editar lista' : 'Nueva lista';
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label={title}>
        <Field label="Nombre de la lista" error={fieldError} hint="Por ejemplo: Interesados de octubre.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" autoFocus />}
        </Field>
        <p className="text-[12.5px] text-muted">
          {editing
            ? editing.kind === 'fixed' ? 'Lista fija: tiene los contactos que elegiste.' : 'Lista dinámica: se actualiza sola según sus filtros.'
            : mode.kind === 'selection'
              ? `Lista fija con los ${mode.ids.length} contactos seleccionados.`
              : 'Lista dinámica con los filtros, el orden y las columnas actuales: se actualiza sola.'}
        </p>
        {tooMany ? <Alert>Una lista nueva admite hasta 500 contactos a la vez. Selecciona menos o agrégalos después.</Alert> : null}
        {canShare ? (
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Compartir con toda la empresa
          </label>
        ) : <p className="text-[12.5px] text-muted">Esta lista es solo tuya.</p>}
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {editing ? (
            confirm ? (
              <span className="flex items-center gap-2 text-[13px]">¿Borrar la lista? Los contactos no se borran.
                <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={remove.isPending} onClick={() => remove.mutate(editing.id, { onSuccess: () => onDone(null), onError: (err) => { setConfirm(false); setError(friendlyError(err, 'No pudimos borrar la lista.')); } })}>Sí, borrar</Button>
                <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(false)}>No</Button>
              </span>
            ) : <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(true)}>Eliminar lista</Button>
          ) : <span />}
          <span className="flex gap-2">
            <Button type="button" onClick={onClose}>Cancelar</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={tooMany}>{editing ? 'Guardar' : 'Crear lista'}</Button>
          </span>
        </div>
      </form>
    </Modal>
  );
}
