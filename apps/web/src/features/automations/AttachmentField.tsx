import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../ui/controls';
import { LibraryAssetPicker } from '../library/LibraryPicker';
import { assetUrl, KIND_LABEL, type AssetKind } from '../library/useLibrary';

/**
 * El archivo de la biblioteca que acompaña al mensaje de una automatización (V21 · 21.3, ADR-75 #6). Guarda solo el id: el nombre y la miniatura se piden aparte (una dirección firmada de pocos
 * minutos). Si el archivo ya no existe o se archivó, lo dice: el paso fallaría al ejecutarse.
 */
export function AttachmentField({ assetId, label, onChange }: { assetId: string | undefined; label: string; onChange: (id: string | undefined) => void }) {
  const [picking, setPicking] = useState(false);
  const info = useQuery({ queryKey: ['library-url', assetId], enabled: !!assetId, retry: false, staleTime: 4 * 60_000, queryFn: () => assetUrl(assetId!) });
  return (
    <div className="grid gap-1.5">
      {assetId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface2 p-2">
          {info.data?.kind === 'image' ? <img src={info.data.url} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <span aria-hidden="true" className="grid h-12 w-12 place-items-center rounded-lg bg-surface text-[11px] font-semibold text-muted">{info.data ? KIND_LABEL[info.data.kind as AssetKind] : '…'}</span>}
          <div className="min-w-0 flex-1">
            {info.isError ? <b className="text-[13px] text-crit">El archivo ya no está disponible (se archivó o se quitó)</b> : <b className="block truncate text-[13px]">{info.data?.name ?? 'Cargando…'}</b>}
            {info.data ? <span className="text-[12px] text-muted">{KIND_LABEL[info.data.kind as AssetKind]}{info.data.kind === 'audio' ? ' · el texto saldrá en un mensaje aparte' : ''}</span> : null}
          </div>
          <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`${label}: cambiar el archivo`} onClick={() => setPicking(true)}>Cambiar</Button>
          <Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`${label}: quitar el archivo`} onClick={() => onChange(undefined)}>Quitar</Button>
        </div>
      ) : (
        <div><Button className="!px-3 !py-1.5 !text-[12.5px]" aria-label={`${label}: adjuntar un archivo de la biblioteca`} onClick={() => setPicking(true)}>Adjuntar de la biblioteca</Button></div>
      )}
      {picking ? <LibraryAssetPicker title="Archivo de la biblioteca" onPick={(a) => { onChange(a.id); setPicking(false); }} onClose={() => setPicking(false)} /> : null}
    </div>
  );
}
