import { useCallback, useState } from 'react';

/**
 * Preferencias de distribución por persona Y empresa, en este navegador (ADR-60): `ss.inbox.layout.v1:<userId>:<orgId>`. Un solo objeto JSON; cada pantalla guarda su parte
 * (la barra lateral aquí; los anchos del Inbox, en su fase). Todo acceso al almacenamiento va en try/catch y lo leído se valida: un valor raro nunca rompe la pantalla.
 * No sigue a la persona entre dispositivos (sincronizarlo sería una decisión aparte con endpoint nuevo).
 */
export interface LayoutPrefs {
  /** Barra lateral: plegada a solo iconos o expandida. Sin valor = el predeterminado de cada tamaño de pantalla. */
  sidebar?: 'collapsed' | 'expanded';
  /** Inbox de escritorio: ancho en px de la lista y del panel de contacto, y si cada uno está abierto. Sin valor = el predeterminado. */
  listWidth?: number;
  contactWidth?: number;
  listOpen?: boolean;
  contactOpen?: boolean;
}

const WIDTH_MIN = 120;
const WIDTH_MAX = 1200;

export const layoutKey = (userId: string, orgId: string): string => `ss.inbox.layout.v1:${userId}:${orgId}`;

export function parseLayout(raw: string | null): LayoutPrefs {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const r = v as Record<string, unknown>;
    const out: LayoutPrefs = {};
    if (r['sidebar'] === 'collapsed' || r['sidebar'] === 'expanded') out.sidebar = r['sidebar'];
    for (const k of ['listWidth', 'contactWidth'] as const) {
      const n = r[k];
      if (typeof n === 'number' && Number.isFinite(n) && n >= WIDTH_MIN && n <= WIDTH_MAX) out[k] = Math.round(n);
    }
    for (const k of ['listOpen', 'contactOpen'] as const) if (typeof r[k] === 'boolean') out[k] = r[k];
    return out;
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

/** Guarda solo lo que cambia, conservando el resto de lo guardado; `remove` borra esas claves (volver al predeterminado). */
export function writeLayout(userId: string, orgId: string, patch: Partial<LayoutPrefs>, remove: ReadonlyArray<keyof LayoutPrefs> = []): void {
  try {
    const next: LayoutPrefs = { ...readLayout(userId, orgId), ...patch };
    for (const k of remove) delete next[k];
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

/** Todas las preferencias de distribución de la persona en esta empresa, con cómo cambiarlas (y volver al predeterminado con `remove`). Al cambiar de persona o de empresa se vuelve a leer. */
export function useLayoutPrefs(userId: string, orgId: string): [LayoutPrefs, (patch: Partial<LayoutPrefs>, remove?: ReadonlyArray<keyof LayoutPrefs>) => void] {
  const [prefs, setPrefs] = useState<LayoutPrefs>(() => readLayout(userId, orgId));
  const [forKey, setForKey] = useState(`${userId}:${orgId}`);
  if (forKey !== `${userId}:${orgId}`) {
    setForKey(`${userId}:${orgId}`);
    setPrefs(readLayout(userId, orgId));
  }
  const update = useCallback(
    (patch: Partial<LayoutPrefs>, remove: ReadonlyArray<keyof LayoutPrefs> = []): void => {
      setPrefs((p) => {
        const next: LayoutPrefs = { ...p, ...patch };
        for (const k of remove) delete next[k];
        return next;
      });
      writeLayout(userId, orgId, patch, remove);
    },
    [userId, orgId],
  );
  return [prefs, update];
}
