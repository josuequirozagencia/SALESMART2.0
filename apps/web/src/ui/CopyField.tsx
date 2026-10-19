import { useState } from 'react';
import { Button } from './controls';

/** Valor de solo lectura (se selecciona al enfocarlo) con un botón «Copiar». Si el portapapeles no está disponible, el valor sigue visible para copiarlo a mano. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin permiso del portapapeles: el valor sigue visible para copiarlo a mano */
    }
  }
  return (
    <div className="grid gap-1">
      <span className="text-[12.5px] font-semibold">{label}</span>
      <div className="flex items-center gap-2">
        <input readOnly aria-label={label} value={value} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 rounded-[10px] border border-line bg-surface2 px-3 py-2 font-mono text-[12.5px]" />
        <Button className="!px-3 !py-2 !text-[12.5px]" aria-label={`Copiar ${label}`} onClick={() => void copy()}>{copied ? 'Copiado' : 'Copiar'}</Button>
      </div>
    </div>
  );
}
