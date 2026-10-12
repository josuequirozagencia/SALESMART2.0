import { useEffect, useState } from 'react';

/** Hora actual que se refresca cada `everyMs` (para cuentas regresivas sin llamar a Date.now() durante el render). */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
