import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Tema claro / oscuro / sistema de TODA la plataforma (ADR-60). Un solo mecanismo: el atributo `data-theme` de <html> (el CSS ya lo entiende) y la preferencia guardada en
 * `localStorage` (`ss.theme.v1`). «Sistema» = sin atributo: manda `prefers-color-scheme`. `public/theme-init.js` lo aplica antes del primer pintado.
 * La preferencia es por navegador (no sigue a la persona entre dispositivos) y todo acceso al almacenamiento va en try/catch.
 */
export type ThemeMode = 'light' | 'dark' | 'system';
export const THEME_KEY = 'ss.theme.v1';

export function parseThemeMode(raw: string | null): ThemeMode {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function readThemeMode(): ThemeMode {
  try {
    return parseThemeMode(window.localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

const listeners = new Set<() => void>();
let snapshot: ThemeMode | null = null;

function getSnapshot(): ThemeMode {
  snapshot ??= readThemeMode();
  return snapshot;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setThemeMode(mode: ThemeMode): void {
  snapshot = mode;
  try {
    if (mode === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* sin almacenamiento: el cambio vale mientras la página siga abierta */
  }
  applyThemeMode(mode);
  for (const l of listeners) l();
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** El tema elegido, el que realmente se ve (en «sistema», el del aparato) y cómo cambiarlo. */
export function useTheme(): { mode: ThemeMode; effective: 'light' | 'dark'; setMode: (m: ThemeMode) => void } {
  const mode = useSyncExternalStore(subscribe, getSnapshot, () => 'system' as ThemeMode);
  // En «sistema», si el aparato cambia de tema hay que volver a pintar
  const tick = useSyncExternalStore(
    useCallback((cb: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    }, []),
    systemPrefersDark,
    () => false,
  );
  useEffect(() => {
    applyThemeMode(mode);
  }, [mode]);
  const effective = mode === 'system' ? (tick ? 'dark' : 'light') : mode;
  return { mode, effective, setMode: setThemeMode };
}
