import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { QuickReplyAsset } from '../../lib/types';
import { Button } from '../../ui/controls';
import { LibraryAssetPicker } from '../library/LibraryPicker';
import { KIND_LABEL, sizeLabel } from '../library/useLibrary';

export const MAX_FILES = 3;
const SMALL = '!px-3 !py-1.5 !text-[12.5px]';

export const filesLabel = (n: number): string => (n === 1 ? '1 archivo' : `${n} archivos`);

const PROBLEM: Record<NonNullable<QuickReplyAsset['problem']>, string> = {
  archived: 'Está archivado en la biblioteca: al usar la respuesta no se podrá enviar.',
  not_for_advisors: 'No está disponible para asesores: no podrás enviarlo.',
  unscanned: 'No pasó por el antivirus y la empresa lo exige: no se puede enviar.',
};

/**
 * «Archivos (hasta 3)» de una respuesta rápida (V25): se ELIGEN de la biblioteca (la respuesta guarda la referencia), se ordenan y se quitan. En esta pantalla de configuración sí se muestra
 * el nombre. Si la respuesta es compartida, un archivo no disponible para asesores se señala: el servidor la rechaza y no se cambia nada en silencio.
 */
export function QuickReplyFiles({ files, shared, onChange }: { files: QuickReplyAsset[]; shared: boolean; onChange: (next: QuickReplyAsset[]) => void }) {
  const [picking, setPicking] = useState(false);
  const move = (i: number, by: -1 | 1): void => {
    const next = [...files];
    const [one] = next.splice(i, 1);
    next.splice(i + by, 0, one!);
    onChange(next);
  };
  return (
    <section aria-label={`Archivos (hasta ${MAX_FILES})`} className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] font-semibold">Archivos (hasta {MAX_FILES})</span>
        <Button className={SMALL} disabled={files.length >= MAX_FILES} onClick={() => setPicking(true)}>Elegir de la biblioteca</Button>
      </div>
      {files.length === 0 ? <p className="text-[12px] text-muted">Sin archivos: la respuesta envía solo el texto.</p> : (
        <ol aria-label="Archivos de la respuesta" className="grid gap-1.5">
          {files.map((f, i) => {
            const label = f.name ?? KIND_LABEL[f.kind as keyof typeof KIND_LABEL] ?? 'Archivo';
            const hidden = shared && !f.usable_by_advisors;
            return (
              <li key={f.id} className="grid gap-1 rounded-lg border border-line bg-surface2 px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-[13px]"><b className="break-words">{label}</b> <span className="text-muted">· {KIND_LABEL[f.kind as keyof typeof KIND_LABEL] ?? f.kind} · {sizeLabel(f.size_bytes)}</span></span>
                  <Button className={SMALL} disabled={i === 0} aria-label={`Subir ${label}`} onClick={() => move(i, -1)}>↑</Button>
                  <Button className={SMALL} disabled={i === files.length - 1} aria-label={`Bajar ${label}`} onClick={() => move(i, 1)}>↓</Button>
                  <Button className={SMALL} aria-label={`Quitar ${label}`} onClick={() => onChange(files.filter((x) => x.id !== f.id))}>Quitar</Button>
                </div>
                {hidden ? <p className="text-[12px] text-warn">Para compartir la respuesta, márcalo como disponible para asesores en la <Link to="/library" className="font-semibold underline">Biblioteca</Link>.</p> : null}
                {f.problem ? <p className="text-[12px] text-warn">{PROBLEM[f.problem]}</p> : null}
              </li>
            );
          })}
        </ol>
      )}
      {files.length > 1 ? <p className="text-[12px] text-muted">Salen en este orden, un mensaje por archivo. El texto acompaña al primero (un audio va primero y el texto aparte).</p> : null}
      {picking ? (
        <LibraryAssetPicker
          title="Elegir un archivo para la respuesta"
          onClose={() => setPicking(false)}
          onPick={(a) => {
            setPicking(false);
            if (files.some((f) => f.id === a.id) || files.length >= MAX_FILES) return;
            onChange([...files, { id: a.id, kind: a.kind, size_bytes: a.size_bytes, name: a.name, usable_by_advisors: a.usable_by_advisors, problem: null }]);
          }}
        />
      ) : null}
    </section>
  );
}
