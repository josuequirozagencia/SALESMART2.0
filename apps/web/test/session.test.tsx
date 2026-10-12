import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, tokens } from '../src/lib/api';
import { anon, authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, trial } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

describe('Sesión (refresh de un solo uso, ADR-26)', () => {
  it('al cargar, recupera la sesión con UN solo refresh aunque React monte el efecto dos veces (StrictMode)', async () => {
    const m = mockApi(authed(ME_ADMIN));
    renderApp('/', { strict: true });
    expect(await screen.findByRole('heading', { name: /Hola, Mi Empresa SA/ })).toBeInTheDocument();
    expect(m.count('POST /auth/refresh')).toBe(1); // un segundo refresh con la cookie ya rotada REVOCARÍA la sesión
    expect(m.last('POST /auth/refresh')?.headers['x-requested-by']).toBe('sales-smart-web'); // anti-CSRF para la cookie
    expect(tokens.get()).toBe('acc-2');
  });

  it('varias peticiones que reciben 401 a la vez comparten UN refresh y se reintentan con el token nuevo', async () => {
    let refreshes = 0;
    const valid = 'nuevo'; // el servidor ya rotó: el token en memoria quedó viejo
    const seen: string[] = [];
    mockApi({
      'POST /auth/refresh': async () => { refreshes++; await new Promise((r) => setTimeout(r, 20)); return { body: { access_token: 'nuevo' } }; },
      'GET /a': (c) => { seen.push(c.headers['authorization'] ?? ''); return c.headers['authorization'] === `Bearer ${valid}` ? { body: { ok: 'a' } } : err(401, 'UNAUTHORIZED'); },
      'GET /b': (c) => (c.headers['authorization'] === `Bearer ${valid}` ? { body: { ok: 'b' } } : err(401, 'UNAUTHORIZED')),
      'GET /c': (c) => (c.headers['authorization'] === `Bearer ${valid}` ? { body: { ok: 'c' } } : err(401, 'UNAUTHORIZED')),
    });
    tokens.set('viejo');
    const out = await Promise.all([api<{ ok: string }>('/a'), api<{ ok: string }>('/b'), api<{ ok: string }>('/c')]);
    expect(out.map((o) => o.ok)).toEqual(['a', 'b', 'c']);
    expect(refreshes).toBe(1);
    expect(seen).toEqual(['Bearer viejo', 'Bearer nuevo']);
  });

  it('si el refresh falla, la sesión se pierde: se limpia el token y la app vuelve al login', async () => {
    let n = 0;
    mockApi({
      ...authed(ME_ADMIN),
      'POST /auth/refresh': () => (++n === 1 ? { body: { access_token: 'acc-2' } } : err(401, 'UNAUTHORIZED')),
      'GET /trials/me': () => err(401, 'UNAUTHORIZED'),
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
    expect(tokens.get()).toBeNull();
  });

  it('cerrar sesión llama al servidor con la cabecera anti-CSRF, borra el token y vuelve al login', async () => {
    const m = mockApi({ ...authed(ME_ADMIN, trial()), 'POST /auth/logout': () => ({ status: 204 }) });
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
    expect(m.last('POST /auth/logout')?.headers['x-requested-by']).toBe('sales-smart-web');
    expect(tokens.get()).toBeNull();
    // tras cerrar, no se vuelve a intentar recuperar la sesión con la cookie vieja
    expect(m.count('POST /auth/refresh')).toBe(1);
  });

  it('cerrar sesión funciona aunque falle la red (la sesión local se cierra igual)', async () => {
    mockApi({ ...authed(ME_ADMIN), 'POST /auth/logout': () => { throw new TypeError('network'); } });
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument());
    expect(tokens.get()).toBeNull();
  });

  it('las rutas públicas (login, registro) NO adjuntan el token ni intentan refrescar ante un 401', async () => {
    const m = mockApi({ 'POST /auth/login': () => err(401, 'UNAUTHORIZED'), 'POST /auth/refresh': () => ({ body: { access_token: 'x' } }) });
    tokens.set('secreto');
    await expect(api('/auth/login', { method: 'POST', auth: false, body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(m.last('POST /auth/login')?.headers['authorization']).toBeUndefined();
    expect(m.count('POST /auth/refresh')).toBe(0);
  });

  it('sin sesión recuperable, el arranque no deja token en memoria', async () => {
    mockApi(anon());
    renderApp('/');
    await screen.findByRole('heading', { name: 'Inicia sesión' });
    expect(tokens.get()).toBeNull();
  });
});
