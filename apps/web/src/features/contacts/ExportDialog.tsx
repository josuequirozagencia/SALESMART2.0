import { useState } from 'react';
import { saveBlob } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import { Alert, Button } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { SORT_PARAMS, hasFilters, type ContactFilters } from './useContacts';
import { exportContacts, type ExportInput } from './useImports';

type Scope = 'selection' | 'view' | 'all';

/**
 * Exportar contactos a CSV (M3.5, ADR-47). Tres alcances: la selección, la vista actual (con sus filtros y la lista abierta) o todos. Las columnas son
 * las visibles de la tabla o todas. Cada exportación queda en la auditoría; el servidor limita a 20 000 filas.
 */
export function ExportDialog({
  selectedIds,
  filters,
  listId,
  listName,
  visibleColumns,
  total,
  onClose,
}: {
  selectedIds: string[];
  filters: ContactFilters;
  /** Id de la lista fija abierta (las dinámicas se exportan por sus filtros, que ya están en `filters`). */
  listId?: string | undefined;
  listName?: string | undefined;
  visibleColumns: string[];
  total: number | null;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>(selectedIds.length > 0 ? 'selection' : 'view');
  const [cols, setCols] = useState<'visible' | 'all'>('visible');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<number | null>(null);

  async function run() {
    setBusy(true);
    setError(undefined);
    setDone(null);
    const s = SORT_PARAMS[filters.sort];
    const base: ExportInput = { scope, ...(cols === 'visible' ? { columns: visibleColumns } : {}), sort: s.sort, order: s.order };
    const input: ExportInput =
      scope === 'selection' ? { ...base, ids: selectedIds }
      : scope === 'all' ? base
      : {
          ...base,
          ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
          ...(filters.owner ? { owner: filters.owner } : {}),
          ...(filters.consent ? { consent: filters.consent } : {}),
          ...(filters.tags.length > 0 ? { tag: filters.tags } : {}),
          ...(filters.cf.length > 0 ? { cf: filters.cf } : {}),
          ...(listId ? { list: listId } : {}),
        };
    try {
      const d = await exportContacts(input);
      saveBlob(d);
      setDone(d.count);
    } catch (e) {
      setError(friendlyError(e, 'No pudimos exportar los contactos.'));
    } finally {
      setBusy(false);
    }
  }

  const filtered = hasFilters(filters);
  const viewLabel = listName ? `La lista «${listName}»${filtered ? ' con los filtros actuales' : ''}` : filtered ? 'Los contactos con los filtros actuales' : 'Los contactos de la vista actual';
  return (
    <Modal title="Exportar contactos" onClose={onClose}>
      <div className="grid gap-3">
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-[12px] font-semibold">Qué exportar</legend>
          {selectedIds.length > 0 ? (
            <label className="flex items-center gap-2 text-[13.5px]"><input type="radio" name="scope" checked={scope === 'selection'} onChange={() => setScope('selection')} />Los {selectedIds.length} contactos seleccionados</label>
          ) : null}
          <label className="flex items-center gap-2 text-[13.5px]"><input type="radio" name="scope" checked={scope === 'view'} onChange={() => setScope('view')} />{viewLabel}{total !== null ? ` (${total})` : ''}</label>
          <label className="flex items-center gap-2 text-[13.5px]"><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />Todos los contactos</label>
        </fieldset>
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-[12px] font-semibold">Columnas</legend>
          <label className="flex items-center gap-2 text-[13.5px]"><input type="radio" name="cols" checked={cols === 'visible'} onChange={() => setCols('visible')} />Las columnas visibles en la tabla</label>
          <label className="flex items-center gap-2 text-[13.5px]"><input type="radio" name="cols" checked={cols === 'all'} onChange={() => setCols('all')} />Todas las columnas</label>
        </fieldset>
        <p className="text-[12px] text-muted">Se descarga un CSV (UTF-8) que abre bien en Excel. Máximo 20 000 contactos por archivo. Cada exportación queda registrada.</p>
        {done !== null ? <Alert kind="ok">Listo: se descargó el archivo con {done} contacto{done === 1 ? '' : 's'}.</Alert> : null}
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button onClick={onClose}>{done !== null ? 'Cerrar' : 'Cancelar'}</Button>
          <Button variant="primary" loading={busy} onClick={() => void run()}>Exportar</Button>
        </div>
      </div>
    </Modal>
  );
}
