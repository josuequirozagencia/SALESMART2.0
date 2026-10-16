import { useMemo, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { CustomField } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { SettingsNav } from '../app/SettingsNav';
import { FieldDialog } from './FieldDialog';
import { FIELD_TYPE_LABEL, useArchiveField, useCustomFields, useReorderFields, useUpdateField } from './useCustomFields';

const small = '!px-3 !py-1.5 !text-[12.5px]';

function Row({
  f,
  manage,
  first,
  last,
  busy,
  onEdit,
  onMove,
  onToggle,
  onArchive,
}: {
  f: CustomField;
  manage: boolean;
  first: boolean;
  last: boolean;
  busy: boolean;
  onEdit: (f: CustomField) => void;
  onMove: (f: CustomField, dir: -1 | 1) => void;
  onToggle: (f: CustomField, prop: 'show_in_form' | 'required', on: boolean) => void;
  onArchive: (f: CustomField, archive: boolean) => void;
}) {
  const archived = f.archived_at !== null;
  return (
    <li className="grid gap-3 rounded-2xl border border-line bg-surface p-4 min-[900px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_120px_130px_100px_auto] min-[900px]:items-center">
      <div className="min-w-0">
        <b className="block truncate text-[14px]">{f.name} {archived ? <Pill kind="muted">Archivado</Pill> : null}</b>
        {f.options ? <span className="block truncate text-[12px] text-muted">{f.options.join(' · ')}</span> : null}
      </div>
      <code className="w-fit max-w-full truncate rounded bg-surface2 px-1.5 py-0.5 text-[12.5px]">{`{{contact.${f.key}}}`}</code>
      <span className="text-[13px]">{FIELD_TYPE_LABEL[f.type]}</span>
      <label className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" aria-label={`Mostrar ${f.name} en el formulario`} checked={f.show_in_form} disabled={!manage || archived || busy} onChange={(e) => onToggle(f, 'show_in_form', e.target.checked)} />
        En el formulario
      </label>
      <label className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" aria-label={`${f.name} es obligatorio`} checked={f.required} disabled={!manage || archived || busy || !f.show_in_form} onChange={(e) => onToggle(f, 'required', e.target.checked)} />
        Obligatorio
      </label>
      {manage ? (
        <div className="flex flex-wrap gap-2">
          {archived ? (
            <Button className={small} aria-label={`Restaurar ${f.name}`} disabled={busy} onClick={() => onArchive(f, false)}>Restaurar</Button>
          ) : (
            <>
              <Button className={small} aria-label={`Editar ${f.name}`} onClick={() => onEdit(f)}>Editar</Button>
              <Button className={small} aria-label={`Subir ${f.name}`} disabled={first || busy} onClick={() => onMove(f, -1)}>↑</Button>
              <Button className={small} aria-label={`Bajar ${f.name}`} disabled={last || busy} onClick={() => onMove(f, 1)}>↓</Button>
              <Button className={small} aria-label={`Archivar ${f.name}`} disabled={busy} onClick={() => onArchive(f, true)}>Archivar</Button>
            </>
          )}
        </div>
      ) : <span />}
    </li>
  );
}

/**
 * Configuración › Campos personalizados (M3.2, ADR-44). El administrador define los datos extra del contacto (tipo, opciones, obligatorio, visible en el
 * formulario), los ordena y los archiva (no se borran: su variable queda reservada). El resto de la gente ve la lista sin acciones. El servidor decide quién
 * puede cambiar algo (`access.manage`); aquí solo se muestra u oculta.
 */
export function CustomFieldsPage() {
  const q = useCustomFields({ archived: true });
  const update = useUpdateField();
  const archive = useArchiveField();
  const reorder = useReorderFields();
  const [dialog, setDialog] = useState<{ field?: CustomField } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string>();

  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const active = useMemo(() => items.filter((f) => f.archived_at === null).sort((a, b) => a.position - b.position), [items]);
  const archivedItems = useMemo(() => items.filter((f) => f.archived_at !== null), [items]);
  const manage = q.data?.access.manage === true;
  const busyId = (update.isPending && update.variables?.id) || (archive.isPending && archive.variables?.id) || undefined;
  const moving = reorder.isPending;

  const fail = (msg: string) => (e: unknown) => setError(friendlyError(e, msg));

  function toggle(f: CustomField, prop: 'show_in_form' | 'required', on: boolean) {
    setError(undefined);
    update.mutate({ id: f.id, input: prop === 'required' ? { required: on } : { show_in_form: on } }, { onError: fail('No pudimos guardar el cambio.') });
  }
  function move(f: CustomField, dir: -1 | 1) {
    setError(undefined);
    const ids = active.map((x) => x.id);
    const i = ids.indexOf(f.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids, { onError: fail('No pudimos cambiar el orden.') });
  }
  function toggleArchive(f: CustomField, doArchive: boolean) {
    setError(undefined);
    archive.mutate({ id: f.id, archive: doArchive }, { onError: fail(doArchive ? 'No pudimos archivar el campo.' : 'No pudimos restaurar el campo.') });
  }

  return (
    <div className="grid gap-4">
      <SettingsNav />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[640px] text-[13.5px] text-muted">
          Datos extra del contacto (por ejemplo: cédula, ciudad o presupuesto). Cada campo queda disponible como variable para plantillas, automatizaciones y la IA. Los campos no se borran: se archivan.
        </p>
        {manage ? <Button variant="primary" onClick={() => setDialog({})}>Nuevo campo</Button> : null}
      </div>
      {q.isSuccess && !manage ? <Alert kind="info">Solo el administrador de la empresa puede cambiar los campos.</Alert> : null}

      {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando campos" /></div> : null}
      {q.isError ? <Alert>{friendlyError(q.error, 'No pudimos cargar los campos.')} <Button variant="link" onClick={() => void q.refetch()}>Reintentar</Button></Alert> : null}
      {q.isSuccess && active.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line p-8 text-center text-[13.5px] text-muted">
          {manage ? 'Aún no hay campos adicionales. Crea el primero con «Nuevo campo».' : 'Aún no hay campos adicionales.'}
        </p>
      ) : null}
      {active.length > 0 ? (
        <ul className="grid gap-2" aria-label="Campos">
          {active.map((f, i) => (
            <Row key={f.id} f={f} manage={manage} first={i === 0} last={i === active.length - 1} busy={moving || busyId === f.id} onEdit={(x) => setDialog({ field: x })} onMove={move} onToggle={toggle} onArchive={toggleArchive} />
          ))}
        </ul>
      ) : null}

      {archivedItems.length > 0 ? (
        <div className="grid gap-2">
          <label className="flex w-fit items-center gap-2 text-[13px]">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Ver archivados ({archivedItems.length})
          </label>
          {showArchived ? (
            <ul className="grid gap-2" aria-label="Campos archivados">
              {archivedItems.map((f) => <Row key={f.id} f={f} manage={manage} first last busy={busyId === f.id} onEdit={() => undefined} onMove={() => undefined} onToggle={() => undefined} onArchive={toggleArchive} />)}
            </ul>
          ) : null}
        </div>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}
      {dialog ? <FieldDialog {...(dialog.field ? { field: dialog.field } : {})} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
