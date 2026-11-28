import type { QuickReplyAsset } from '../../lib/types';
import { Icon } from '../../ui/Icon';
import { KIND_LABEL, sizeLabel, useAssetThumb, type LibraryAsset } from '../library/useLibrary';

const kindName = (k: string): string => (KIND_LABEL[k as keyof typeof KIND_LABEL] ?? 'Archivo').toLowerCase();

function Chip({ file, unavailable, onRemove }: { file: QuickReplyAsset; unavailable: boolean; onRemove: () => void }) {
  const thumb = useAssetThumb(file as unknown as LibraryAsset, !unavailable);
  return (
    <li className={`flex min-h-11 shrink-0 items-center gap-2 rounded-xl border py-1 pl-1.5 pr-1 text-[12.5px] ${unavailable ? 'border-crit bg-crit-soft text-crit' : 'border-line bg-surface2'}`}>
      {file.kind === 'image' && thumb.data ? <img src={thumb.data.url} alt="" className="size-9 rounded-lg object-cover" /> : <span aria-hidden="true" className="grid size-9 place-items-center rounded-lg bg-surface text-muted"><Icon name="note" size={18} /></span>}
      <span className="whitespace-nowrap">
        <b className="capitalize">{kindName(file.kind)}</b> <span className="text-muted">{sizeLabel(file.size_bytes)}</span>
        {unavailable ? <span className="block font-semibold">No disponible</span> : null}
      </span>
      <button type="button" aria-label={`Archivo adjunto: ${kindName(file.kind)}, ${sizeLabel(file.size_bytes)}. Quitar`} title="Quitar" onClick={onRemove} className="grid size-11 place-items-center rounded-full text-muted hover:bg-surface hover:text-fg"><Icon name="close" size={16} /></button>
    </li>
  );
}

/** Los archivos de la respuesta rápida elegida, bajo el cuadro de texto (V25): una fila con desplazamiento horizontal. Nunca muestran el nombre del archivo. */
export function QuickReplyChips({ files, unavailable, onRemove }: { files: QuickReplyAsset[]; unavailable: ReadonlySet<string>; onRemove: (id: string) => void }) {
  return (
    <ul aria-label="Archivos que se enviarán" className="flex w-full gap-2 overflow-x-auto pb-1">
      {files.map((f) => <Chip key={f.id} file={f} unavailable={unavailable.has(f.id) || f.problem !== null} onRemove={() => onRemove(f.id)} />)}
    </ul>
  );
}
