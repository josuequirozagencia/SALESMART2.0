import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { faviconMime, faviconProblem, refreshTabIcon, type BrandingView } from '../src/features/platform/useBranding';
import { authed, err, ME_ROOT, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); document.head.querySelectorAll('link[rel="icon"]').forEach((l) => l.remove()); });

const NO_TRIALS = { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } };
const EMPTY: BrandingView = { has_favicon: false, version: null, content_type: null, bytes: null, px: null, updated_at: null };
const SET: BrandingView = { has_favicon: true, version: 'aaaaaaaa-0000-4000-8000-000000000001', content_type: 'image/png', bytes: 2048, px: 64, updated_at: '2026-11-10T15:00:00.000Z' };

function server(initial: BrandingView = EMPTY, over: Record<string, Handler> = {}): { routes: Record<string, Handler>; puts: number[]; deletes: number } {
  let state = initial;
  const s = { puts: [] as number[], deletes: 0 };
  const routes: Record<string, Handler> = {
    ...authed(ME_ROOT, null),
    'GET /platform/trials': () => ({ body: NO_TRIALS }),
    'GET /platform/branding': () => ({ body: state }),
    'PUT /platform/branding/favicon': ({ body }) => { s.puts.push((body as { raw_bytes: number }).raw_bytes); state = SET; return { body: state }; },
    'DELETE /platform/branding/favicon': () => { s.deletes += 1; state = EMPTY; return { body: state }; },
    ...over,
  };
  return { routes, get puts() { return s.puts; }, get deletes() { return s.deletes; } };
}
const file = (name: string, type: string, size = 100): File => new File([new Uint8Array(size)], name, { type });

describe('reglas del archivo (solo ayuda: el servidor vuelve a validar el contenido)', () => {
  it('rechaza SVG, vacíos y los de más de 256 KB; acepta el resto', () => {
    expect(faviconProblem({ name: 'logo.svg', type: 'image/svg+xml', size: 10 })).toMatch(/SVG/);
    expect(faviconProblem({ name: 'logo.SVG', type: '', size: 10 })).toMatch(/SVG/);
    expect(faviconProblem({ name: 'a.png', type: 'image/png', size: 0 })).toMatch(/vacío/);
    expect(faviconProblem({ name: 'a.png', type: 'image/png', size: 256 * 1024 + 1 })).toMatch(/256 KB/);
    expect(faviconProblem({ name: 'a.png', type: 'image/png', size: 256 * 1024 })).toBeNull();
    expect(faviconProblem({ name: 'a.ico', type: 'image/x-icon', size: 4000 })).toBeNull();
  });

  it('el tipo que se manda: el del navegador o, si no dice nada, el de la extensión', () => {
    expect(faviconMime({ name: 'a.png', type: 'image/png' })).toBe('image/png');
    expect(faviconMime({ name: 'a.ico', type: '' })).toBe('image/x-icon');
    expect(faviconMime({ name: 'a.webp', type: '' })).toBe('image/webp');
    expect(faviconMime({ name: 'a.xyz', type: '' })).toBe('application/octet-stream');
  });

  it('refreshTabIcon cambia el icono de esta pestaña con la versión nueva', () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = '/v1/branding/favicon';
    document.head.appendChild(link);
    refreshTabIcon('v-9');
    expect(link.getAttribute('href')).toBe('/v1/branding/favicon?v=v-9');
    refreshTabIcon(null);
    expect(link.getAttribute('href')).toBe('/v1/branding/favicon?v=default');
  });
});

describe('Plataforma › Marca (solo Súper Admin)', () => {
  it('la consola tiene «Marca»; sin favicon propio dice que se usa el de por omisión y no ofrece quitar', async () => {
    mockApi(server().routes);
    renderApp('/platform/branding');
    expect(await screen.findByRole('link', { name: 'Marca' })).toHaveAttribute('href', '/platform/branding');
    expect(await screen.findByText(/Todavía no subes uno/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subir favicon' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Quitar favicon' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Requisitos del archivo' })).toHaveTextContent(/PNG, ICO o WebP/);
    expect(screen.getByAltText('Favicon actual')).toHaveAttribute('src', '/v1/branding/favicon?v=default');
  });

  it('subir una imagen la manda al servidor, muestra el resultado y ofrece cambiarla o quitarla', async () => {
    const s = server();
    mockApi(s.routes);
    renderApp('/platform/branding');
    const input = await screen.findByLabelText('Elegir un favicon');
    await userEvent.upload(input, file('icono.png', 'image/png', 2048));
    expect(await screen.findByText(/Favicon actualizado/)).toBeInTheDocument();
    expect(s.puts).toEqual([2048]);
    expect(await screen.findByText(/Imagen propia · 64 × 64 px · 2 KB/)).toBeInTheDocument();
    expect(screen.getByAltText('Favicon actual')).toHaveAttribute('src', `/v1/branding/favicon?v=${SET.version}`);
    expect(screen.getByRole('button', { name: 'Cambiar favicon' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quitar favicon' })).toBeInTheDocument();
  });

  it('un SVG o un archivo de más de 256 KB se rechazan en la pantalla, sin llamar al servidor', async () => {
    const s = server();
    mockApi(s.routes);
    renderApp('/platform/branding');
    const input = await screen.findByLabelText('Elegir un favicon');
    await userEvent.upload(input, file('logo.svg', 'image/svg+xml'), { applyAccept: false });
    expect(await screen.findByText(/No se aceptan archivos SVG/)).toBeInTheDocument();
    await userEvent.upload(input, file('grande.png', 'image/png', 300 * 1024));
    expect(await screen.findByText(/máximo es 256 KB/)).toBeInTheDocument();
    expect(s.puts).toEqual([]);
  });

  it('si el servidor rechaza la imagen (no cuadrada, dañada…), se muestra su motivo y no cambia nada', async () => {
    const s = server(EMPTY, { 'PUT /platform/branding/favicon': () => err(400, 'FAVICON_NOT_SQUARE', 'La imagen debe ser cuadrada (la tuya mide 64 × 32 px)') });
    mockApi(s.routes);
    renderApp('/platform/branding');
    await userEvent.upload(await screen.findByLabelText('Elegir un favicon'), file('rara.png', 'image/png'));
    expect(await screen.findByText('La imagen debe ser cuadrada (la tuya mide 64 × 32 px)')).toBeInTheDocument();
    expect(screen.getByText(/Todavía no subes uno/)).toBeInTheDocument();
  });

  it('quitar pide confirmación y, al confirmar, vuelve al icono por omisión', async () => {
    const s = server(SET);
    mockApi(s.routes);
    renderApp('/platform/branding');
    await userEvent.click(await screen.findByRole('button', { name: 'Quitar favicon' }));
    expect(s.deletes).toBe(0); // todavía no
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.queryByRole('group', { name: 'Confirmar quitar el favicon' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Quitar favicon' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, quitar' }));
    expect(await screen.findByText(/Favicon quitado/)).toBeInTheDocument();
    await waitFor(() => expect(s.deletes).toBe(1));
    expect(await screen.findByText(/Todavía no subes uno/)).toBeInTheDocument();
  });
});
