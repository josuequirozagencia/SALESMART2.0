import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Cajón superpuesto (ADR-60): desde la derecha (`right`, el panel de contacto en tablet y móvil) o hoja inferior (`bottom`, los filtros de la lista móvil), con el fondo atenuado. `role="dialog"` y `aria-modal`; se cierra con
 * Esc, tocando fuera o con el botón del propio panel (`onClose`); el foco entra al abrir, queda atrapado dentro (Tab y Mayús+Tab dan la vuelta) y se devuelve a quien lo abrió al cerrar.
 */
export function Drawer({ label, onClose, children, placement = 'right' }: { label: string; onClose: () => void; children: ReactNode; placement?: 'right' | 'bottom' }) {
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
    <div className={`fixed inset-0 z-40 flex ${placement === 'bottom' ? 'items-end' : 'justify-end'}`}>
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-black/45" />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={key} className={placement === 'bottom' ? 'relative flex max-h-[85dvh] w-full flex-col overflow-y-auto rounded-t-2xl bg-surface pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow)] outline-none' : 'relative flex h-full w-[min(380px,100%)] shadow-[var(--shadow)] outline-none'}>
        {children}
      </div>
    </div>
  );
}
