import { useCallback, useState } from 'react';

/**
 * Preferencias de distribución por persona Y empresa, en este navegador (ADR-60): `ss.inbox.layout.v1:<userId>:<orgId>`. Un solo objeto JSON; cada pantalla guarda su parte
 * (la barra lateral aquí; los anchos del Inbox, en su fase). Todo acceso al almacenamiento va en try/catch y lo leído se valida: un valor raro nunca rompe la pantalla.
 * No sigue a la persona entre dispositivos (sincronizarlo sería una decisión aparte con endpoint nuevo).
 */
export interface LayoutPrefs {
  /** Barra lateral: plegada a solo iconos o expandida. Sin valor = el predeterminado de cada tamaño de pantalla. */
  sidebar?: 'collapsed' | 'expanded';
}

export const layoutKey = (userId: string, orgId: string): string => `ss.inbox.layout.v1:${userId}:${orgId}`;

export function parseLayout(raw: string | null): LayoutPrefs {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const sidebar = (v as Record<string, unknown>)['sidebar'];
    return sidebar === 'collapsed' || sidebar === 'expanded' ? { sidebar } : {};
  } catch {
    return {};
  }
}

export function readLayout(userId: string, orgId: string): LayoutPrefs {
  try {
    return parseLayout(window.localStorage.getItem(layoutKey(userId, orgId)));
  } catch {
    return {};
  }
}

/** Guarda solo lo que cambia, conservando el resto de lo guardado. */
export function writeLayout(userId: string, orgId: string, patch: Partial<LayoutPrefs>): void {
  try {
    const next = { ...readLayout(userId, orgId), ...patch };
    window.localStorage.setItem(layoutKey(userId, orgId), JSON.stringify(next));
  } catch {
    /* sin almacenamiento: la preferencia vale mientras la página siga abierta */
  }
}

/** Barra lateral plegada o no, por persona y empresa. `fallback` es lo que se usa mientras la persona no haya elegido. */
export function useSidebarCollapsed(userId: string, orgId: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [stored, setStored] = useState<LayoutPrefs['sidebar']>(() => readLayout(userId, orgId).sidebar);
  const [forKey, setForKey] = useState(`${userId}:${orgId}`);
  // Al cambiar de persona o de empresa (agencia, soporte) se vuelve a leer la preferencia de la nueva
  if (forKey !== `${userId}:${orgId}`) {
    setForKey(`${userId}:${orgId}`);
    setStored(readLayout(userId, orgId).sidebar);
  }
  const collapsed = stored === undefined ? fallback : stored === 'collapsed';
  const set = useCallback(
    (v: boolean): void => {
      const value = v ? 'collapsed' : 'expanded';
      setStored(value);
      writeLayout(userId, orgId, { sidebar: value });
    },
    [userId, orgId],
  );
  return [collapsed, set];
}
