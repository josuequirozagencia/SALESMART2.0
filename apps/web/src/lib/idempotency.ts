import { useRef } from 'react';

/** Una llave nueva por operación. */
export const newKey = (): string => `web-${crypto.randomUUID()}`;

/**
 * Llave de idempotencia de UNA operación: se reutiliza mientras se reintente exactamente lo mismo (doble clic, red caída) y cambia en cuanto cambian los datos
 * (con la misma llave y otros datos el servidor responde IDEMPOTENCY_MISMATCH). `reset` la renueva al terminar bien.
 */
export function useIdempotencyKey(): { keyFor: (signature: unknown) => string; reset: () => void } {
  const ref = useRef<{ sig: string; key: string } | null>(null);
  return {
    keyFor: (signature) => {
      const sig = JSON.stringify(signature);
      if (!ref.current || ref.current.sig !== sig) ref.current = { sig, key: newKey() };
      return ref.current.key;
    },
    reset: () => {
      ref.current = null;
    },
  };
}
