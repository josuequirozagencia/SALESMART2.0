import { useEffect, useRef, useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button } from '../../ui/controls';
import { useRequestExtension } from './useTrial';

const MIN = 10;
const MAX = 500;

/** Modal accesible para pedir la única extensión de la prueba (motivo obligatorio). Escape o «Cancelar» cierran. */
export function ExtensionDialog({ days, onClose }: { days: number; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = useRequestExtension();

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = reason.trim();
    if (r.length < MIN) return setError('Cuéntanos en una frase para qué necesitas más tiempo');
    setError(undefined);
    send.mutate(r, { onSuccess: onClose, onError: (err) => setError(friendlyError(err)) });
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form role="dialog" aria-modal="true" aria-labelledby="ext-title" onSubmit={submit} noValidate className="grid w-[min(460px,100%)] gap-3 rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow)]">
        <h2 id="ext-title" className="text-[18px] font-bold">Pedir {days} días más</h2>
        <p className="text-[13px] text-muted">
          Puedes pedir una extensión una sola vez. Un asesor de la plataforma revisa tu solicitud; si se aprueba, tu prueba sigue activa {days} días más.
        </p>
        <label htmlFor="ext-why" className="text-[12.5px] font-semibold">¿Para qué necesitas más tiempo?</label>
        <textarea
          id="ext-why"
          ref={ref}
          rows={3}
          maxLength={MAX}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={error ? true : undefined}
          placeholder="Ej.: aún estoy conectando mi WhatsApp y probando los agentes"
          className="w-full rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[14px] aria-[invalid=true]:border-crit"
        />
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={send.isPending}>Enviar solicitud</Button>
        </div>
      </form>
    </div>
  );
}
