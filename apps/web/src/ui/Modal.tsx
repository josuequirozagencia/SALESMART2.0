import { useEffect, useId, type ReactNode } from 'react';

/** Diálogo modal accesible: título enlazado, Escape y clic fuera cierran, el contenido se coloca dentro. */
export function Modal({ title, onClose, children, wide, xl }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; xl?: boolean }) {
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/55 p-4 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={id} className={`grid gap-3 rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow)] ${xl ? 'w-[min(760px,100%)]' : wide ? 'w-[min(560px,100%)]' : 'w-[min(480px,100%)]'}`}>
        <h2 id={id} className="text-[18px] font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}
