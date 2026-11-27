import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Field, Input, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { PageHeader } from '../../ui/PageHeader';
import { Pill } from '../../ui/Pill';
import { RequestSpaceDialog } from './RequestSpaceDialog';
import { assetUrl, KIND_LABEL, sizeLabel, useAssetThumb, useAssetUsage, useLibrary, useLibraryAccess, useLibraryMutations, useUploadAsset, type AssetChanges, type LibraryAsset, type LibraryFilter, type LibraryFolder, type LibraryUsage } from './useLibrary';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-[9px] text-[13.5px] font-normal text-fg';
const SMALL = '!px-3 !py-1.5 !text-[12.5px]';
const KINDS = [['', 'Todos los tipos'], ['image', 'Imágenes'], ['document', 'Documentos'], ['video', 'Videos'], ['audio', 'Audios']] as const;

/** La barra de espacio usado: ámbar desde el 80 %, roja al llenarse. Solo la ve quien administra. */
function UsageBar({ usage }: { usage: LibraryUsage }) {
  const [asking, setAsking] = useState(false);
  const pct = usage.quota_bytes > 0 ? Math.min(100, Math.round((usage.used_bytes / usage.quota_bytes) * 100)) : 100;
  const tone = pct >= 100 ? 'bg-crit' : pct >= 80 ? 'bg-warn' : 'bg-accent';
  const expiry = usage.next_expiry_at ? new Date(usage.next_expiry_at).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  return (
    <section aria-label="Espacio de la biblioteca" className="grid gap-1.5 rounded-2xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <b>{sizeLabel(usage.used_bytes)} de {sizeLabel(usage.quota_bytes)} usados</b>
        <span className="text-muted">{usage.assets} archivo(s)</span>
      </div>
      <div role="progressbar" aria-label="Espacio usado" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded-full bg-surface2">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {usage.extra_bytes > 0 ? <p className="text-[12px] text-muted">Incluye {sizeLabel(usage.included_bytes)} de tu plan y {sizeLabel(usage.extra_bytes)} de espacio extra{expiry ? `; el extra más próximo vence el ${expiry}` : ''}.</p> : null}
      {pct >= 100 ? (
        <div className="grid gap-2 rounded-xl bg-crit-soft p-3">
          <p className="text-[13px] font-semibold text-crit">Tu empresa llegó a su límite de espacio: no se pueden subir más archivos. Lo que ya subiste sigue disponible.</p>
          {usage.request ? <p className="text-[12.5px]">Solicitud enviada{usage.request.plan_name ? ` (${usage.request.plan_name})` : ''}: el equipo la está revisando.</p> : <div><Button variant="primary" className={SMALL} onClick={() => setAsking(true)}>Solicitar más espacio</Button></div>}
        </div>
      ) : pct >= 80 ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[12.5px] text-warn">Te queda poco espacio ({sizeLabel(usage.available_bytes)}).</p>
          {usage.request ? <span className="text-[12.5px] text-muted">Solicitud enviada: el equipo la está revisando.</span> : <Button className={SMALL} onClick={() => setAsking(true)}>Solicitar más espacio</Button>}
        </div>
      ) : null}
      {asking ? <RequestSpaceDialog onClose={() => setAsking(false)} /> : null}
    </section>
  );
}

/** Miniatura de una imagen o una etiqueta del tipo para lo demás. */
function Thumb({ asset }: { asset: LibraryAsset }) {
  const thumb = useAssetThumb(asset);
  if (asset.kind === 'image' && thumb.data) return <img src={thumb.data.url} alt={`Vista previa de «${asset.name}»`} loading="lazy" className="h-28 w-full rounded-t-2xl object-cover" />;
  return <div aria-hidden="true" className="grid h-28 w-full place-items-center rounded-t-2xl bg-surface2 text-[12.5px] font-semibold text-muted">{KIND_LABEL[asset.kind]}</div>;
}

function AssetCard({ asset, manage, folders, onEdit, onArchive, onView }: { asset: LibraryAsset; manage: boolean; folders: LibraryFolder[]; onEdit: (a: LibraryAsset) => void; onArchive: (a: LibraryAsset) => void; onView: (a: LibraryAsset) => void }) {
  const folder = folders.find((f) => f.id === asset.folder_id);
  return (
    <li className="grid content-start rounded-2xl border border-line bg-surface">
      <Thumb asset={asset} />
      <div className="grid gap-1 p-3">
        <b className="break-words text-[13.5px]" title={asset.name}>{asset.name}</b>
        <span className="text-[12px] text-muted">{KIND_LABEL[asset.kind]} · {sizeLabel(asset.size_bytes)}{folder ? ` · ${folder.name}` : ''}</span>
        {asset.description ? <p className="line-clamp-2 break-words text-[12.5px] text-muted">{asset.description}</p> : null}
        <div className="flex flex-wrap gap-1">
          {asset.state === 'archived' ? <Pill kind="muted">Archivado</Pill> : manage ? (asset.usable_by_advisors ? <Pill kind="ok">Para asesores</Pill> : <Pill kind="muted">Solo administración</Pill>) : null}
          {asset.scan_status === 'skipped' ? <span title="El archivo no se revisó con un antivirus"><Pill kind="warn">Sin revisar</Pill></span> : null}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Button className={SMALL} aria-label={`Ver ${asset.name}`} onClick={() => onView(asset)}>Ver</Button>
          {manage && asset.state === 'ready' ? <Button className={SMALL} aria-label={`Editar ${asset.name}`} onClick={() => onEdit(asset)}>Editar</Button> : null}
          {manage && asset.state === 'ready' ? <Button className={SMALL} aria-label={`Archivar ${asset.name}`} onClick={() => onArchive(asset)}>Archivar</Button> : null}
        </div>
      </div>
    </li>
  );
}

function EditDialog({ asset, folders, onClose }: { asset: LibraryAsset; folders: LibraryFolder[]; onClose: () => void }) {
  const { update } = useLibraryMutations();
  const [name, setName] = useState(asset.name);
  const [description, setDescription] = useState(asset.description ?? '');
  const [folder, setFolder] = useState(asset.folder_id ?? '');
  const [advisors, setAdvisors] = useState(asset.usable_by_advisors);
  const [error, setError] = useState<string>();
  const save = (): void => {
    if (name.trim() === '') return setError('Escribe un nombre');
    const changes: AssetChanges = {};
    if (name.trim() !== asset.name) changes.name = name.trim();
    if (description.trim() !== (asset.description ?? '')) changes.description = description.trim() === '' ? null : description.trim();
    if ((folder || null) !== asset.folder_id) changes.folder_id = folder || null;
    if (advisors !== asset.usable_by_advisors) changes.usable_by_advisors = advisors;
    if (Object.keys(changes).length === 0) return onClose();
    setError(undefined);
    update.mutate({ id: asset.id, changes }, { onSuccess: onClose, onError: (e) => setError(friendlyError(e, 'No se pudo guardar el archivo')) });
  };
  return (
    <Modal title="Editar archivo" onClose={onClose}>
      <Field label="Nombre">{(f) => <Input {...f} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label="Descripción (opcional)" hint="Para reconocerlo rápido: qué es y cuándo usarlo.">{(f) => <Input {...f} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <Field label="Carpeta">
        {(f) => (
          <select {...f} value={folder} onChange={(e) => setFolder(e.target.value)} className={`${selectCls} w-full`}>
            <option value="">Sin carpeta</option>
            {folders.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        )}
      </Field>
      <label className="flex items-center gap-2 text-[13.5px]">
        <input type="checkbox" checked={advisors} onChange={(e) => setAdvisors(e.target.checked)} />
        <span><b>Disponible para los asesores</b><span className="block text-[12px] text-muted">Podrán verlo y enviarlo desde el chat. Si lo desmarcas, solo la administración lo ve.</span></span>
      </label>
      <label className="flex items-center gap-2 text-[13.5px] opacity-60">
        <input type="checkbox" checked={asset.usable_by_ai} disabled />
        <span><b>Disponible para la IA</b> <span className="text-[12px] text-muted">(próximamente)</span></span>
      </label>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={update.isPending} onClick={save}>Guardar</Button>
      </div>
    </Modal>
  );
}

function ConfirmArchive({ asset, onClose }: { asset: LibraryAsset; onClose: () => void }) {
  const { archive } = useLibraryMutations();
  const usage = useAssetUsage(asset.id);
  const rules = usage.data?.automations ?? [];
  const [error, setError] = useState<string>();
  return (
    <Modal title="Archivar archivo" onClose={onClose}>
      <p className="text-[13.5px]">¿Archivar «{asset.name}»? Deja de verse y de poder enviarse, y libera su espacio. Lo que ya se envió a clientes no cambia.</p>
      {rules.length > 0 ? (
        <Alert kind="info">
          <p>Este archivo lo usan {rules.length === 1 ? 'esta automatización' : 'estas automatizaciones'}: al archivarlo, ese paso fallará hasta que le pongas otro archivo.</p>
          <ul className="mt-1 list-disc pl-5">{rules.map((r) => <li key={r.id}>{r.name}{r.status === 'active' ? '' : r.status === 'paused' ? ' (en pausa)' : ' (borrador)'}</li>)}</ul>
        </Alert>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={archive.isPending} onClick={() => archive.mutate(asset.id, { onSuccess: onClose, onError: (e) => setError(friendlyError(e, 'No se pudo archivar')) })}>Archivar</Button>
      </div>
    </Modal>
  );
}

/** Nombre de una carpeta: crear una nueva o renombrar la elegida. */
function FolderDialog({ folder, onClose, onDone }: { folder: LibraryFolder | null; onClose: () => void; onDone: (f: LibraryFolder) => void }) {
  const { createFolder, renameFolder } = useLibraryMutations();
  const [name, setName] = useState(folder?.name ?? '');
  const [error, setError] = useState<string>();
  const pending = createFolder.isPending || renameFolder.isPending;
  const save = (): void => {
    if (name.trim() === '') return setError('Escribe el nombre de la carpeta');
    setError(undefined);
    const opts = { onSuccess: (f: LibraryFolder) => onDone(f), onError: (e: unknown) => setError(friendlyError(e, 'No se pudo guardar la carpeta')) };
    if (folder) renameFolder.mutate({ id: folder.id, name: name.trim() }, opts);
    else createFolder.mutate(name.trim(), opts);
  };
  return (
    <Modal title={folder ? 'Renombrar carpeta' : 'Nueva carpeta'} onClose={onClose}>
      <Field label="Nombre de la carpeta">{(f) => <Input {...f} value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />}</Field>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={pending} onClick={save}>Guardar</Button>
      </div>
    </Modal>
  );
}

function ConfirmArchiveFolder({ folder, onClose, onDone }: { folder: LibraryFolder; onClose: () => void; onDone: () => void }) {
  const { archiveFolder } = useLibraryMutations();
  const [error, setError] = useState<string>();
  return (
    <Modal title="Archivar carpeta" onClose={onClose}>
      <p className="text-[13.5px]">¿Archivar la carpeta «{folder.name}»? Solo se puede si está vacía.</p>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={archiveFolder.isPending} onClick={() => archiveFolder.mutate(folder.id, { onSuccess: onDone, onError: (e) => setError(friendlyError(e, 'No se pudo archivar la carpeta')) })}>Archivar</Button>
      </div>
    </Modal>
  );
}

interface UploadLine { key: number; name: string; state: 'uploading' | 'ok' | 'error'; message?: string }

/**
 * Biblioteca de archivos (V21, ADR-75): fotos de productos, catálogos, PDF, audios y videos de la empresa. Quien administra sube (también arrastrando), ordena en carpetas de un nivel, edita y archiva, y ve el
 * espacio usado; el asesor solo ve y abre lo marcado para asesores (los envía desde el chat). El servidor decide todo; esto solo lo muestra.
 */
export function LibraryPage() {
  const access = useLibraryAccess();
  const [filter, setFilter] = useState<LibraryFilter>({ folder: 'all', q: '', kind: '' });
  const [search, setSearch] = useState('');
  const q = useLibrary(filter);
  const upload = useUploadAsset();
  const fileInput = useRef<HTMLInputElement>(null);
  const [lines, setLines] = useState<UploadLine[]>([]);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<LibraryAsset | null>(null);
  const [archiving, setArchiving] = useState<LibraryAsset | null>(null);
  const [folderDialog, setFolderDialog] = useState<'new' | LibraryFolder | null>(null);
  const [archivingFolder, setArchivingFolder] = useState<LibraryFolder | null>(null);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);

  const first = q.data?.pages[0];
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const folders = first?.folders ?? [];
  const manage = first?.access.manage === true || access.data?.manage === true;
  const selectedFolder = folders.find((f) => f.id === filter.folder) ?? null;

  const view = async (a: LibraryAsset): Promise<void> => {
    setNotice(undefined);
    try {
      const r = await assetUrl(a.id);
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setNotice(friendlyError(e, 'No se pudo abrir el archivo'));
    }
  };

  const uploadAll = async (files: File[]): Promise<void> => {
    const folderId = filter.folder !== 'all' && filter.folder !== 'root' ? filter.folder : undefined;
    for (const file of files) {
      const key = Date.now() + Math.random();
      setLines((l) => [...l, { key, name: file.name, state: 'uploading' }]);
      try {
        await upload.mutateAsync({ file, folderId });
        setLines((l) => l.map((x) => (x.key === key ? { ...x, state: 'ok' } : x)));
      } catch (e) {
        setLines((l) => l.map((x) => (x.key === key ? { ...x, state: 'error', message: friendlyError(e, 'No se pudo subir') } : x)));
      }
    }
  };
  const onPick = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) void uploadAll(files);
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    if (!manage) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void uploadAll(files);
  };

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Biblioteca"
        description="Fotos, catálogos, PDF, audios y videos de tu empresa. Los asesores los envían desde el chat."
        actions={manage ? (
          <>
            <Button onClick={() => setFolderDialog('new')}>Nueva carpeta</Button>
            <Button variant="primary" loading={upload.isPending} onClick={() => fileInput.current?.click()}>Subir archivos</Button>
            <input ref={fileInput} type="file" multiple hidden aria-label="Elegir archivos para subir" accept="image/jpeg,image/png,video/mp4,video/3gpp,audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/amr,audio/webm,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" onChange={onPick} />
          </>
        ) : null}
      />

      {first?.usage ? <UsageBar usage={first.usage} /> : null}
      {first && !first.storage_available ? <Alert kind="info">El almacenamiento de archivos todavía no está configurado en este servidor: no se pueden subir ni abrir archivos. Avisa a soporte.</Alert> : null}
      {notice ? <Alert>{notice}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="library-search">Buscar archivos</label>
        <input id="library-search" type="search" placeholder="Buscar por nombre" value={search} onChange={(e) => setSearch(e.target.value)} className={`${selectCls} min-w-[200px] flex-1`} />
        <label className="sr-only" htmlFor="library-kind">Tipo de archivo</label>
        <select id="library-kind" value={filter.kind} onChange={(e) => setFilter({ ...filter, kind: e.target.value as LibraryFilter['kind'] })} className={selectCls}>
          {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {manage ? (
          <label className="flex items-center gap-1.5 text-[13px]">
            <input type="checkbox" checked={filter.archived === true} onChange={(e) => setFilter({ ...filter, archived: e.target.checked })} />Ver archivados
          </label>
        ) : null}
      </div>

      <div role="group" aria-label="Carpetas" className="flex flex-wrap items-center gap-1.5">
        {([['all', 'Todas'], ['root', 'Sin carpeta']] as const).map(([v, l]) => (
          <button key={v} type="button" aria-pressed={filter.folder === v} onClick={() => setFilter({ ...filter, folder: v })} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold ${filter.folder === v ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>{l}</button>
        ))}
        {folders.map((f) => (
          <button key={f.id} type="button" aria-pressed={filter.folder === f.id} onClick={() => setFilter({ ...filter, folder: f.id })} className={`rounded-full border px-3 py-1 text-[12.5px] font-semibold ${filter.folder === f.id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}>{f.name} ({f.asset_count})</button>
        ))}
        {manage && selectedFolder ? (
          <>
            <Button className={SMALL} onClick={() => setFolderDialog(selectedFolder)}>Renombrar carpeta</Button>
            <Button className={SMALL} onClick={() => setArchivingFolder(selectedFolder)}>Archivar carpeta</Button>
          </>
        ) : null}
      </div>

      {lines.length > 0 ? (
        <ul aria-label="Subidas" className="grid gap-1 rounded-2xl border border-line bg-surface p-3 text-[13px]">
          {lines.map((l) => (
            <li key={l.key} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words">{l.name}</span>
              {l.state === 'uploading' ? <span className="text-muted">Subiendo…</span> : l.state === 'ok' ? <Pill kind="ok">Subido</Pill> : <span className="text-crit">{l.message}</span>}
            </li>
          ))}
          <li><Button className={SMALL} onClick={() => setLines((l) => l.filter((x) => x.state === 'uploading'))}>Limpiar</Button></li>
        </ul>
      ) : null}

      <div
        onDragOver={(e) => { if (manage) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-2xl ${dragging ? 'outline-dashed outline-2 outline-accent' : ''}`}
      >
        {q.isPending ? <div className="grid place-items-center py-10 text-muted"><Spinner label="Cargando la biblioteca" /></div> : null}
        {q.isError ? <Alert>{friendlyError(q.error, 'No tienes acceso a la biblioteca o no se pudo cargar.')}</Alert> : null}
        {q.isSuccess && items.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line py-10 text-center text-[13.5px] text-muted">
            {filter.q || filter.kind || filter.folder !== 'all' ? 'No hay archivos con esos filtros.' : manage ? 'Todavía no hay archivos. Sube el primero o arrástralo aquí.' : 'Todavía no hay archivos disponibles para ti.'}
          </p>
        ) : null}
        {items.length > 0 ? (
          <ul aria-label="Archivos" className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
            {items.map((a) => <AssetCard key={a.id} asset={a} manage={manage} folders={folders} onEdit={setEditing} onArchive={setArchiving} onView={(x) => void view(x)} />)}
          </ul>
        ) : null}
        {q.hasNextPage ? <div className="mt-3 grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Ver más</Button></div> : null}
      </div>

      {editing ? <EditDialog asset={editing} folders={folders} onClose={() => setEditing(null)} /> : null}
      {archiving ? <ConfirmArchive asset={archiving} onClose={() => setArchiving(null)} /> : null}
      {folderDialog ? <FolderDialog folder={folderDialog === 'new' ? null : folderDialog} onClose={() => setFolderDialog(null)} onDone={(f) => { setFolderDialog(null); setFilter((x) => ({ ...x, folder: f.id })); }} /> : null}
      {archivingFolder ? <ConfirmArchiveFolder folder={archivingFolder} onClose={() => setArchivingFolder(null)} onDone={() => { setArchivingFolder(null); setFilter((x) => ({ ...x, folder: 'all' })); }} /> : null}
    </div>
  );
}
