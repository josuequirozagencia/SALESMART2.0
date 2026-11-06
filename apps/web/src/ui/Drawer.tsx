import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Cajón superpuesto desde la derecha (ADR-60): en tablet y móvil muestra el panel de contacto encima del chat, con el fondo atenuado. `role="dialog"` y `aria-modal`; se cierra con
 * Esc, tocando fuera o con el botón del propio panel (`onClose`); el foco entra al abrir, queda atrapado dentro (Tab y Mayús+Tab dan la vuelta) y se devuelve a quien lo abrió al cerrar.
 */
export function Drawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    const root = panel.current;
    const first = root?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root)?.focus();
    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl?.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl?.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/45" />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={key} className="relative flex h-full w-[min(380px,100%)] shadow-[var(--shadow)] outline-none">
        {children}
      </div>
    </div>
  );
}
