import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const asAdmin: Me = { ...ME_ADMIN, view_as_options: ['advisor'] };
const watching: Me = { ...asAdmin, read_only: true, viewing_as: 'advisor' };

/** Servidor con estado: «ver como» cambia lo que devuelve /auth/me. */
function server(start: Me = asAdmin, extra: Record<string, Handler> = {}) {
  const st = { me: start, posts: [] as unknown[] };
  const routes: Record<string, Handler> = {
    ...authed(start),
    'GET /auth/me': () => ({ body: st.me }),
    'POST /context/view-as': ({ body }) => {
      st.posts.push(body);
      const role = (body as { role: 'advisor' | null }).role;
      st.me = role ? { ...asAdmin, read_only: true, viewing_as: role } : asAdmin;
      return { body: st.me };
    },
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }),
    ...extra,
  };
  return { st, routes };
}

describe('«Ver como»', () => {
  it('el administrador ve el selector en el menú; al elegir Asesor aparece la barra permanente con «Solo lectura» y «Volver a mi vista», y el selector desaparece', async () => {
    const { st, routes } = server();
    mockApi(routes);
    renderApp('/');
    const menu = within(await screen.findByRole('region', { name: 'Ver como' }));
    expect(screen.queryByRole('region', { name: 'Viendo como otro rol' })).not.toBeInTheDocument();
    await userEvent.click(menu.getByRole('button', { name: 'Ver como Asesor' }));
    const bar = within(await screen.findByRole('region', { name: 'Viendo como otro rol' }));
    expect(bar.getByText(/Viendo como/)).toHaveTextContent('Viendo como Asesor · Solo lectura');
    expect(st.posts).toEqual([{ role: 'advisor' }]);
    expect(screen.queryByRole('region', { name: 'Ver como' })).not.toBeInTheDocument();
    // (ADR-60) en móvil ya no hay barra superior con la marca «Viendo como»: la barra permanente de arriba es la que lo dice
    await userEvent.click(bar.getByRole('button', { name: 'Volver a mi vista' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Viendo como otro rol' })).not.toBeInTheDocument());
    expect(st.posts).toEqual([{ role: 'advisor' }, { role: null }]);
    expect(await screen.findByRole('region', { name: 'Ver como' })).toBeInTheDocument();
  });

  it('si ya se estaba mirando como otro rol al cargar (la vista vive en la sesión), la barra está desde el primer momento', async () => {
    mockApi(server(watching).routes);
    renderApp('/');
    expect(await screen.findByRole('region', { name: 'Viendo como otro rol' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Ver como' })).not.toBeInTheDocument();
  });

  it('quien no tiene nada que elegir (un asesor) no ve selector ni barra', async () => {
    mockApi({ ...authed(ME_ADVISOR), 'GET /custom-fields': () => ({ body: { items: [], access: { manage: false } } }) });
    renderApp('/');
    await screen.findByRole('navigation', { name: 'Secciones' });
    expect(screen.queryByRole('region', { name: 'Ver como' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Viendo como otro rol' })).not.toBeInTheDocument();
  });

  it('si el servidor rechaza la vista (404 uniforme) se explica y se puede reintentar; no cambia nada', async () => {
    const { routes } = server(asAdmin, { 'POST /context/view-as': () => err(404, 'NOT_FOUND', 'No encontrado') });
    mockApi(routes);
    renderApp('/');
    await userEvent.click(within(await screen.findByRole('region', { name: 'Ver como' })).getByRole('button', { name: 'Ver como Asesor' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Viendo como otro rol' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ver como Asesor' })).toBeEnabled();
  });

  it('al volver a la vista propia, los datos no se quedan: se piden de nuevo con los permisos de la vista', async () => {
    const { routes } = server(asAdmin, { 'GET /contacts': () => ({ body: { items: [], next_cursor: null, access: { view_all: true, write: true, delete: true, import: true, export: true } } }) });
    const api = mockApi(routes);
    renderApp('/contacts');
    await screen.findByRole('heading', { name: 'Contactos' });
    const before = api.count('GET /contacts');
    await userEvent.click(within(await screen.findByRole('region', { name: 'Ver como' })).getByRole('button', { name: 'Ver como Asesor' }));
    await screen.findByRole('region', { name: 'Viendo como otro rol' });
    await waitFor(() => expect(api.count('GET /contacts')).toBeGreaterThan(before));
  });
});
