import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../src/App';
import { tokens } from '../src/lib/api';
import { pendingSignup } from '../src/lib/pending';
import { createQueryClient } from '../src/lib/query';
import { resetBootstrapForTests, SessionProvider } from '../src/lib/session';
import type { Me, Trial } from '../src/lib/types';

export interface Call { method: string; path: string; query: URLSearchParams; body: unknown; headers: Record<string, string> }
export interface Reply { status?: number; body?: unknown; headers?: Record<string, string> }
export type Handler = (call: Call) => Reply | Promise<Reply>;

/** Sustituye `fetch` por un servidor simulado. Una ruta sin manejador FALLA la prueba (no se silencia). */
export function mockApi(routes: Record<string, Handler>): { calls: Call[]; count: (key: string) => number; last: (key: string) => Call | undefined } {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const [path = '', qs = ''] = String(input).replace(/^https?:\/\/[^/]+/, '').replace(/^\/v1/, '').split('?');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const call: Call = { method, path, query: new URLSearchParams(qs), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers };
    calls.push(call);
    const h = routes[`${method} ${path}`];
    if (!h) throw new Error(`Ruta sin manejador en la prueba: ${method} ${path}`);
    const r = await h(call);
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { 'content-type': 'application/json', ...r.headers } });
  });
  const key = (c: Call) => `${c.method} ${c.path}`;
  return { calls, count: (k) => calls.filter((c) => key(c) === k).length, last: (k) => [...calls].reverse().find((c) => key(c) === k) };
}

export const err = (status: number, code: string, message = 'x', extra: Partial<Reply> = {}): Reply => ({ status, body: { error: { code, message, request_id: 'req_1', details: [] } }, ...extra });

export const ME_ADMIN: Me = { user: { id: 'u1', email: 'ana@empresa.test', full_name: 'Ana Pérez' }, organization: { id: 'o1', name: 'Mi Empresa SA', kind: 'client' }, role: 'client_admin' };
export const ME_ADVISOR: Me = { ...ME_ADMIN, user: { id: 'u2', email: 'luis@empresa.test', full_name: 'Luis Navas' }, role: 'advisor' };
export const ME_ROOT: Me = { user: { id: 'u0', email: 'root@plataforma.test', full_name: null }, organization: { id: 'p1', name: 'Plataforma', kind: 'platform' }, role: 'super_admin' };

export const trial = (over: Partial<Trial> = {}, ext: Partial<Trial['extension']> = {}): Trial => ({
  status: 'active',
  started_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  ends_at: new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString(),
  retention_days: 30,
  extension_days: 3,
  extension: { status: 'none', can_request: true, requested_at: null, decided_at: null, days_granted: null, ...ext },
  ...over,
});

export const loginReply = (me: Me): Reply => ({ body: { ...me, access_token: 'acc-1', token_type: 'Bearer', expires_in: 900 } });

/** Estado limpio entre pruebas (el token y el registro en curso viven en memoria del módulo). */
export function resetWorld(): void {
  tokens.set(null);
  pendingSignup.clear();
  resetBootstrapForTests();
  window.history.replaceState(null, '', '/');
}

export function renderApp(path = '/', opts: { strict?: boolean } = {}) {
  const qc = createQueryClient();
  const tree = (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, ...render(opts.strict ? <StrictMode>{tree}</StrictMode> : tree) };
}

/** Rutas base de una persona SIN sesión (el arranque intenta refrescar y el servidor responde 401). */
export const anon = (): Record<string, Handler> => ({ 'POST /auth/refresh': () => err(401, 'UNAUTHORIZED') });

/** Rutas base de una persona CON sesión recuperable por la cookie. */
export const authed = (me: Me, t: Trial | null = trial()): Record<string, Handler> => ({
  'POST /auth/refresh': () => ({ body: { access_token: 'acc-2', token_type: 'Bearer', expires_in: 900 } }),
  'GET /auth/me': () => ({ body: me }),
  'GET /trials/me': () => (t ? { body: t } : err(404, 'NOT_FOUND')),
});
