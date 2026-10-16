import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, CSRF_HEADER, CSRF_VALUE, onSessionLost, refreshSession, tokens } from './api';
import type { LoginResponse, Me } from './types';

export type AuthState = { status: 'loading' } | { status: 'anon' } | { status: 'authed'; me: Me };

interface SessionApi {
  state: AuthState;
  login(email: string, password: string): Promise<Me>;
  logout(): Promise<void>;
  /** Entra a otra organización (o vuelve al origen con `null`) sin cerrar sesión. El servidor decide si hay derecho (404 si no). */
  switchContext(target: string | null): Promise<Me>;
}

const Ctx = createContext<SessionApi | null>(null);

/**
 * Recuperar la sesión al cargar la página: UN solo refresh aunque el efecto se ejecute dos veces (React StrictMode en
 * desarrollo, montajes repetidos). Un segundo refresh con la cookie ya rotada revocaría la sesión (ADR-26).
 */
let boot: Promise<Me | null> | null = null;
function bootstrap(): Promise<Me | null> {
  boot ??= (async () => {
    if (!(await refreshSession())) return null;
    try {
      return await api<Me>('/auth/me');
    } catch {
      return null;
    }
  })();
  return boot;
}
/** Solo pruebas: cada test arranca sin sesión recordada. */
export function resetBootstrapForTests(): void {
  boot = null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const qc = useQueryClient();

  useEffect(() => {
    let alive = true;
    void bootstrap().then((me) => {
      if (alive) setState(me ? { status: 'authed', me } : { status: 'anon' });
    });
    const off = onSessionLost(() => {
      tokens.set(null);
      qc.clear();
      setState({ status: 'anon' });
    });
    return () => {
      alive = false;
      off();
    };
  }, [qc]);

  const login = useCallback(async (email: string, password: string): Promise<Me> => {
    const r = await api<LoginResponse>('/auth/login', { method: 'POST', auth: false, body: { email, password } });
    tokens.set(r.access_token);
    const me: Me = { user: r.user, organization: r.organization, role: r.role, home: r.home, acting_as: r.acting_as, read_only: r.read_only, access_level: r.access_level };
    qc.clear(); // nada de datos de una sesión anterior
    setState({ status: 'authed', me });
    return me;
  }, [qc]);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api<void>('/auth/logout', { method: 'POST', auth: false, body: {}, headers: { [CSRF_HEADER]: CSRF_VALUE } });
    } catch {
      /* aunque falle la red, la sesión local se cierra; el servidor la vence sola */
    }
    tokens.set(null);
    boot = Promise.resolve(null);
    qc.clear();
    setState({ status: 'anon' });
  }, [qc]);

  const switchContext = useCallback(async (target: string | null): Promise<Me> => {
    const me = await api<Me>('/context/switch', { method: 'POST', body: { target } });
    qc.clear(); // los datos de un contexto jamás se muestran en otro
    setState({ status: 'authed', me });
    return me;
  }, [qc]);

  const value = useMemo(() => ({ state, login, logout, switchContext }), [state, login, logout, switchContext]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession fuera de SessionProvider');
  return v;
}
