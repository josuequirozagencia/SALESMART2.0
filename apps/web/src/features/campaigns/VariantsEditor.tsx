import { useState } from 'react';
import { Alert, Button } from '../../ui/controls';
import { Pill } from '../../ui/Pill';
import { campaignError } from './labels';
import { useGenerateVariants } from './useCampaigns';

/** Cuántas versiones puede tener una campaña además del mensaje principal (lo mismo que exige el servidor). */
export const MAX_VARIANTS = 10;
const areaCls = 'w-full rounded-[11px] border border-line-strong bg-surface px-3 py-[9px] text-[13.5px] font-normal text-fg placeholder:text-muted/70';
const inputCls = 'w-20 rounded-[10px] border border-line-strong bg-surface px-3 py-[8px] text-[13.5px] font-normal text-fg';

/**
 * «Versiones» del mensaje de una campaña por WhatsApp QR (v17, ADR-72 · variantes con IA): el mismo texto enviado a cientos de personas es lo que WhatsApp castiga, así que cada contacto recibe UNA
 * versión distinta. La persona las escribe o le pide a la IA que las genere (con los créditos de su empresa), y SIEMPRE las revisa: puede editarlas o borrarlas. Las que escribe la IA ya vienen
 * validadas por el servidor (mismas variables, sin números ni enlaces nuevos). Nada se guarda hasta que se guarda la campaña.
 */
export function VariantsEditor({ text, variants, onChange }: { text: string; variants: string[]; onChange: (v: string[]) => void }) {
  const gen = useGenerateVariants();
  const [count, setCount] = useState(5);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const room = MAX_VARIANTS - variants.length;
  const wanted = Math.max(1, Math.min(count, room));

  const generate = (): void => {
    setNote(undefined);
    setError(undefined);
    gen.mutate(
      { text: text.trim(), count: wanted },
      {
        onSuccess: (r) => {
          onChange([...variants, ...r.variants].slice(0, MAX_VARIANTS));
          setNote(`Se agregaron ${r.variants.length} ${r.variants.length === 1 ? 'versión' : 'versiones'} (usó ${r.credits_used} ${r.credits_used === 1 ? 'crédito' : 'créditos'}${r.rejected > 0 ? `; se descartaron ${r.rejected} que no respetaban tu mensaje` : ''}). Revísalas antes de enviar.`);
        },
        onError: (e) => setError(campaignError(e, 'No pudimos generar las versiones.')),
      },
    );
  };
  const set = (i: number, v: string): void => onChange(variants.map((x, j) => (j === i ? v : x)));

  return (
    <section aria-label="Versiones del mensaje" className="grid gap-2.5 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[13px] font-semibold">Versiones del mensaje</h4>
        <Pill kind="accent">IA</Pill>
      </div>
      <p className="text-[12.5px] text-muted">Escríbelo una vez. La IA crea versiones distintas para que cada contacto no reciba exactamente el mismo texto. Revísalas: puedes editarlas o borrarlas. Variar el texto reduce el riesgo de bloqueo, pero no lo elimina.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-[12.5px]">Cantidad
          <input type="number" inputMode="numeric" min={1} max={Math.max(1, room)} value={count} onChange={(e) => setCount(Number(e.target.value))} className={inputCls} disabled={room <= 0} />
        </label>
        <Button loading={gen.isPending} disabled={text.trim() === '' || room <= 0} onClick={generate}>Generar versiones</Button>
        <Button disabled={room <= 0} onClick={() => onChange([...variants, ''])}>+ Escribir versión</Button>
      </div>
      {room <= 0 ? <p className="text-[12px] text-muted">Llegaste al máximo de {MAX_VARIANTS} versiones.</p> : null}
      {error ? <Alert>{error}</Alert> : null}
      {note ? <Alert kind="ok">{note}</Alert> : null}
      {variants.length > 0 ? (
        <ol className="grid gap-2" aria-label="Lista de versiones">
          {variants.map((v, i) => (
            <li key={i} className="grid gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-muted">Versión {i + 2}</span>
                <Button variant="link" className="!px-2 !py-1 !text-[12px]" aria-label={`Quitar versión ${i + 2}`} onClick={() => onChange(variants.filter((_, j) => j !== i))}>Quitar</Button>
              </div>
              <textarea className={areaCls} rows={3} maxLength={1000} aria-label={`Versión ${i + 2}`} value={v} onChange={(e) => set(i, e.target.value)} placeholder="Escribe otra forma de decir lo mismo" />
            </li>
          ))}
        </ol>
      ) : null}
      {variants.length > 0 ? <p className="text-[12px] text-muted" aria-live="polite">Cada contacto recibirá una de las {variants.length + 1} versiones (la principal y {variants.length === 1 ? 'una más' : `${variants.length} más`}).</p> : null}
    </section>
  );
}
