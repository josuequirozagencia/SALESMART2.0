import { useEffect, useState } from 'react';

const isTextField = (el: Element | null): boolean => {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'range', 'file', 'color'].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
};

/**
 * ¿Está abierto el teclado virtual? Se deduce de `visualViewport`: hay un campo de texto con el foco y la altura visible es mucho menor que la mayor que se ha visto
 * (en algunos aparatos `innerHeight` también se encoge con el teclado, por eso no se compara solo con él). Sin `visualViewport` siempre es falso.
 * No se puede validar sin aparatos reales (iOS y Android se comportan distinto): ver la lista de lo no validado del ADR-60.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let tallest = Math.max(vv.height, window.innerHeight);
    const update = (): void => {
      tallest = Math.max(tallest, vv.height);
      setOpen(isTextField(document.activeElement) && vv.height < tallest * 0.8);
    };
    vv.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      vv.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);
  return open;
}
