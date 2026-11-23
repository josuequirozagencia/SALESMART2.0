import { useEffect, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import type { Conversation } from '../../lib/types';
import { Alert, Button, Spinner } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { KIND_LABEL, sizeLabel, useAssetThumb, useLibrary, useSendLibraryAsset, type LibraryAsset, type LibraryFilter } from './useLibrary';

const selectCls = 'rounded-[10px] border border-line bg-surface px-3 py-[9px] text-[13.5px] font-normal text-fg';

function PickCard({ asset, selected, onPick }: { asset: LibraryAsset; selected: boolean; onPick: (a: LibraryAsset) => void }) {
  const thumb = useAssetThumb(asset);
  return (
    <li>
      <button type="button" aria-pressed={selected} aria-label={`Elegir ${asset.name}`} onClick={() => onPick(asset)} className={`grid w-full overflow-hidden rounded-xl border text-left ${selected ? 'border-accent ring-2 ring-accent' : 'border-line hover:border-line-strong'}`}>
        {asset.kind === 'image' && thumb.data ? <img src={thumb.data.url} alt="" loading="lazy" className="h-20 w-full object-cover" /> : <span aria-hidden="true" className="grid h-20 w-full place-items-center bg-surface2 text-[12px] font-semibold text-muted">{KIND_LABEL[asset.kind]}</span>}
        <span className="grid gap-0.5 p-2">
          <b className="line-clamp-2 break-words text-[12.5px]">{asset.name}</b>
          <span className="text-[11.5px] text-muted">{KIND_LABEL[asset.kind]} · {sizeLabel(asset.size_bytes)}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * Elegir un archivo de la biblioteca y enviarlo a esta conversación (V21, ADR-75). El servidor lo copia a un adjunto propio y lo manda como un archivo normal: mismas reglas (dueño de la
 * conversación, ventana de 24 h en WhatsApp oficial). El asesor solo ve lo marcado para asesores. Con audio no hay pie de texto.
 */
export function LibraryPicker({ c, onClose }: { c: Conversation; onClose: () => void }) {
  const [filter, setFilter] = useState<LibraryFilter>({ folder: 'all', q: '', kind: '' });
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<LibraryAsset | null>(null);
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string>();
  const q = useLibrary(filter);
  const send = useSendLibraryAsset(c.id);
  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const folders = q.data?.pages[0]?.folders ?? [];
  const closedWindow = !c.window.open;
  const submit = (): void => {
    if (!picked) return;
    setError(undefined);
    send.mutate({ assetId: picked.id, ...(caption.trim() && picked.kind !== 'audio' ? { caption: caption.trim() } : {}) }, { onSuccess: onClose, onError: (e) => setError(friendlyError(e, 'No se pudo enviar el archivo')) });
  };
  return (
    <Modal title="Biblioteca" onClose={onClose} wide>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="library-pick-search">Buscar en la biblioteca</label>
        <input id="library-pick-search" type="search" placeholder="Buscar por nombre" value={search} onChange={(e) => setSearch(e.target.value)} className={`${selectCls} min-w-[160px] flex-1`} />
        <label className="sr-only" htmlFor="library-pick-folder">Carpeta</label>
        <select id="library-pick-folder" value={filter.folder} onChange={(e) => setFilter({ ...filter, folder: e.target.value })} className={selectCls}>
          <option value="all">Todas las carpetas</option>
          <option value="root">Sin carpeta</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>
      {closedWindow ? <Alert kind="info">Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite escribirle con una plantilla aprobada, así que por ahora no puedes enviarle archivos.</Alert> : null}
      <div className="max-h-[46vh] overflow-y-auto">
        {q.isPending ? <div className="grid place-items-center py-8 text-muted"><Spinner label="Cargando la biblioteca" /></div> : null}
        {q.isError ? <Alert>{friendlyError(q.error, 'No se pudo cargar la biblioteca')}</Alert> : null}
        {q.isSuccess && items.length === 0 ? <p className="py-8 text-center text-[13.5px] text-muted">{filter.q || filter.folder !== 'all' ? 'No hay archivos con esos filtros.' : 'La biblioteca todavía no tiene archivos para ti.'}</p> : null}
        {items.length > 0 ? <ul aria-label="Archivos de la biblioteca" className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(130px,1fr))]">{items.map((a) => <PickCard key={a.id} asset={a} selected={picked?.id === a.id} onPick={setPicked} />)}</ul> : null}
        {q.hasNextPage ? <div className="mt-2 grid place-items-center"><Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Ver más</Button></div> : null}
      </div>
      {picked ? (
        <div className="grid gap-2 rounded-xl border border-line bg-surface2 p-3">
          <p className="text-[13px]"><b>{picked.name}</b> · {KIND_LABEL[picked.kind]} · {sizeLabel(picked.size_bytes)}</p>
          {picked.kind === 'audio' ? <p className="text-[12px] text-muted">Los audios se envían sin texto.</p> : (
            <label className="grid gap-1 text-[12.5px] font-semibold">Texto que acompaña al archivo (opcional)
              <textarea value={caption} maxLength={1024} rows={2} onChange={(e) => setCaption(e.target.value)} className="rounded-[10px] border border-line bg-surface px-3 py-2 text-[14px] font-normal" />
            </label>
          )}
        </div>
      ) : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={send.isPending} disabled={!picked || closedWindow} onClick={submit}>Enviar archivo</Button>
      </div>
    </Modal>
  );
}
