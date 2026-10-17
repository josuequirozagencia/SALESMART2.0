import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import type { ContactTag } from '../../lib/types';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { Pill } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { useCreateTag, useDeleteTag, useTags, useUpdateTag } from './useTags';

const DEFAULT_COLOR = '#6a44f2';

/** Alta y edición de una etiqueta personalizada: nombre y color. */
function TagDialog({ tag, onClose }: { tag?: ContactTag; onClose: () => void }) {
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState(tag?.color ?? DEFAULT_COLOR);
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();
  const create = useCreateTag();
  const update = useUpdateTag();

  function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (n === '') return setFieldError('Escribe el nombre de la etiqueta');
    if (n.length > 60) return setFieldError('Usa como máximo 60 caracteres');
    setFieldError(undefined);
    setError(undefined);
    const h = { onSuccess: onClose, onError: (err: unknown) => setError(friendlyError(err, 'No pudimos guardar la etiqueta.')) };
    if (tag) update.mutate({ id: tag.id, input: { name: n, color } }, h);
    else create.mutate({ name: n, color }, h);
  }
  const title = tag ? 'Editar etiqueta' : 'Nueva etiqueta';
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-3" aria-label={title}>
        <Field label="Nombre" error={fieldError}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="off" autoFocus />}</Field>
        <Field label="Color">{(p) => <input {...p} type="color" value={color} onChange={(e) => setColor(e.target.value.toLowerCase())} className="h-10 w-20 cursor-pointer rounded-[10px] border border-line bg-surface p-1" />}</Field>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={create.isPending || update.isPending}>{tag ? 'Guardar' : 'Crear etiqueta'}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Configuración › Etiquetas (M3.4, ADR-46). Las del SISTEMA (Lead, Cita agendada, Venta) las pone el sistema y no se tocan; las personalizadas las crea el
 * administrador y se ponen a los contactos al crearlos o editarlos. Borrar una etiqueta no borra contactos.
 */
export function TagsPage() {
  const q = useTags();
  const remove = useDeleteTag();
  const [dialog, setDialog] = useState<{ tag?: ContactTag } | null>(null);
  const [confirm, setConfirm] = useState<string>();
  const [error, setError] = useState<string>();
  const manage = q.data?.access.manage === true;
  const items = q.data?.items ?? [];
  const system = items.filter((t) => t.is_system);
  const custom = items.filter((t) => !t.is_system);

  return (
    <div className="grid gap-4">
      <SettingsNav />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[640px] text-[13.5px] text-muted">Las etiquetas del sistema las pone el sistema solo. Las tuyas sirven para clasificar y filtrar contactos.</p>
        {manage ? <Button variant="primary" onClick={() => setDialog({})}>Nueva etiqueta</Button> : null}
      </div>
      {q.isSuccess && !manage ? <Alert kind="info">Solo el administrador de la empresa puede crear o cambiar etiquetas.</Alert> : null}
      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando etiquetas" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar las etiquetas.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}

      {q.isSuccess ? (
        <>
          <section aria-label="Etiquetas del sistema" className="grid gap-2">
            <h2 className="text-[15px] font-bold">Del sistema</h2>
            <ul className="flex flex-wrap gap-2">
              {system.map((t) => (
                <li key={t.id} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[13px]">
                  <span aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: t.color }} />{t.name} <Pill kind="muted">Sistema</Pill>
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="Etiquetas personalizadas" className="grid gap-2">
            <h2 className="text-[15px] font-bold">Personalizadas</h2>
            {custom.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[13.5px] text-muted">{manage ? 'Aún no hay etiquetas personalizadas. Crea la primera con «Nueva etiqueta».' : 'Aún no hay etiquetas personalizadas.'}</p>
            ) : (
              <ul className="grid gap-2" aria-label="Etiquetas">
                {custom.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line bg-surface p-3">
                    <span className="inline-flex items-center gap-2 text-[14px] font-semibold"><span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: t.color }} />{t.name}</span>
                    {manage ? (
                      confirm === t.id ? (
                        <span className="flex items-center gap-2 text-[13px]">¿Borrar «{t.name}»? Los contactos no se borran.
                          <Button variant="danger" className="!px-3 !py-1.5 !text-[12.5px]" loading={remove.isPending} onClick={() => remove.mutate(t.id, { onSuccess: () => setConfirm(undefined), onError: (e) => { setConfirm(undefined); setError(friendlyError(e, 'No pudimos borrar la etiqueta.')); } })}>Sí, borrar</Button>
                          <Button className="!px-3 !py-1.5 !text-[12.5px]" onClick={() => setConfirm(undefined)}>No</Button>
                        </span>
                      ) : (
                        <span className="flex gap-2">
                          <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Editar ${t.name}`} onClick={() => setDialog({ tag: t })}>Editar</Button>
                          <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`Borrar ${t.name}`} onClick={() => setConfirm(t.id)}>Borrar</Button>
                        </span>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      {dialog ? <TagDialog {...(dialog.tag ? { tag: dialog.tag } : {})} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
