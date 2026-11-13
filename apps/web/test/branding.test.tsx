import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBrand, resetBrand } from '../src/lib/platformBrand';
import { iconProblem, logoProblem, soundProblem, type BrandingView } from '../src/features/platform/useBranding';
import { authed, err, ME_ROOT, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

vi.mock('../src/features/platform/testNotification', () => ({ showTestNotification: vi.fn() }));
import { showTestNotification } from '../src/features/platform/testNotification';
vi.mock('../src/lib/notifySound', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/notifySound')>()), testSound: vi.fn() }));
import { testSound } from '../src/lib/notifySound';

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(showTestNotification).mockReset();
  vi.mocked(testSound).mockReset();
  resetWorld();
  resetBrand();
  document.title = '';
  document.head.querySelectorAll('link[rel="icon"]').forEach((l) => l.remove());
});

const NO_TRIALS = { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } };
const EMPTY: BrandingView = {
  name: null, short_name: null, default_name: 'Sales Smart 2.0', effective_name: 'Sales Smart 2.0',
  icon: { custom: false, version: null, px: null, has_badge: false, updated_at: null }, logo_light: null, logo_dark: null, sound: null, updated_at: null,
};
const ICON_V = 'aaaaaaaa-0000-4000-8000-000000000001';
const SOUND_V = 'bbbbbbbb-0000-4000-8000-000000000002';

interface Server { routes: Record<string, Handler>; puts: Array<{ path: string; bytes: number; type: string | undefined }>; calls: Record<string, Call[]>; view: () => BrandingView }

function server(initial: BrandingView = EMPTY, over: Record<string, Handler> = {}): Server {
  let state = initial;
  const s: Server = { routes: {}, puts: [], calls: {}, view: () => state };
  const rec = (k: string, c: Call): void => { (s.calls[k] ??= []).push(c); };
  const raw = (path: string, apply: (v: BrandingView) => BrandingView): Handler => (c) => { s.puts.push({ path, bytes: (c.body as { raw_bytes: number }).raw_bytes, type: c.headers['content-type'] }); state = apply(state); return { body: state }; };
  s.routes = {
    ...authed(ME_ROOT, null),
    'GET /platform/trials': () => ({ body: NO_TRIALS }),
    'GET /platform/branding': () => ({ body: state }),
    'PUT /platform/branding': (c) => { rec('name', c); const b = c.body as { name: string | null; short_name: string | null }; state = { ...state, name: b.name, short_name: b.short_name, effective_name: b.name ?? state.default_name }; return { body: state }; },
    'PUT /platform/branding/icon': raw('icon', (v) => ({ ...v, icon: { custom: true, version: ICON_V, px: 1024, has_badge: true, updated_at: '2026-11-12T15:00:00.000Z' } })),
    'DELETE /platform/branding/icon': () => { state = { ...state, icon: EMPTY.icon }; return { body: state }; },
    'PUT /platform/branding/logo-light': raw('logo-light', (v) => ({ ...v, logo_light: { version: 'l1', bytes: 4096, content_type: 'image/png', px: 400 } })),
    'PUT /platform/branding/logo-dark': raw('logo-dark', (v) => ({ ...v, logo_dark: { version: 'd1', bytes: 3072, content_type: 'image/webp', px: 300 } })),
    'DELETE /platform/branding/logo-light': () => { state = { ...state, logo_light: null }; return { body: state }; },
    'PUT /platform/branding/sound': raw('sound', (v) => ({ ...v, sound: { version: SOUND_V, bytes: 30 * 1024, content_type: 'audio/mpeg' } })),
    'DELETE /platform/branding/sound': () => { state = { ...state, sound: null }; return { body: state }; },
    'GET /branding': () => ({ body: { name: state.effective_name, short_name: state.short_name ?? state.effective_name.slice(0, 12), version: state.icon.version ?? 'default-1', icon: { custom: state.icon.custom, favicon: '/v1/branding/favicon', apple_touch: '/v1/branding/apple-touch-icon.png', icon_192: `/v1/branding/icon-192.png?v=${state.icon.version ?? 'default-1'}`, icon_512: '/v1/branding/icon-512.png', badge_96: '/v1/branding/badge-96.png' }, logo: { light: state.logo_light ? '/v1/branding/logo-light?v=l1' : null, dark: state.logo_dark ? '/v1/branding/logo-dark?v=d1' : null }, sound: state.sound ? `/v1/branding/sound?v=${state.sound.version}` : null } }),
    ...over,
  };
  return s;
}
const file = (name: string, type: string, size = 100): File => new File([new Uint8Array(size)], name, { type });
const section = async (name: string) => within(await screen.findByRole('region', { name }));

describe('reglas de los archivos (solo ayuda: el servidor vuelve a validar el contenido)', () => {
  it('el icono: PNG, sin SVG, no vacío y hasta 1 MB', () => {
    expect(iconProblem({ name: 'a.png', type: 'image/png', size: 5000 })).toBeNull();
    expect(iconProblem({ name: 'a', type: 'image/png', size: 5000 })).toBeNull();
    expect(iconProblem({ name: 'a.PNG', type: '', size: 5000 })).toBeNull();
    expect(iconProblem({ name: 'logo.svg', type: 'image/svg+xml', size: 10 })).toMatch(/SVG/);
    expect(iconProblem({ name: 'logo.SVG', type: '', size: 10 })).toMatch(/SVG/);
    expect(iconProblem({ name: 'a.png', type: 'image/png', size: 0 })).toMatch(/vacío/);
    expect(iconProblem({ name: 'a.png', type: 'image/png', size: 1024 * 1024 + 1 })).toMatch(/1 MB/);
    expect(iconProblem({ name: 'a.jpg', type: 'image/jpeg', size: 100 })).toMatch(/PNG cuadrado de al menos 512/);
  });
  it('el logo: PNG o WebP', () => {
    expect(logoProblem({ name: 'a.png', type: 'image/png', size: 100 })).toBeNull();
    expect(logoProblem({ name: 'a.webp', type: 'image/webp', size: 100 })).toBeNull();
    expect(logoProblem({ name: 'a.jpg', type: 'image/jpeg', size: 100 })).toMatch(/PNG o un WebP/);
    expect(logoProblem({ name: 'a.svg', type: 'image/svg+xml', size: 100 })).toMatch(/SVG/);
  });

  it('el sonido: MP3 o M4A, no vacío y hasta 200 KB', () => {
    expect(soundProblem({ name: 'ping.mp3', type: 'audio/mpeg', size: 30_000 })).toBeNull();
    expect(soundProblem({ name: 'ping.m4a', type: 'audio/mp4', size: 30_000 })).toBeNull();
    expect(soundProblem({ name: 'ping.m4a', type: 'audio/x-m4a', size: 30_000 })).toBeNull();
    expect(soundProblem({ name: 'ping.MP3', type: '', size: 30_000 })).toBeNull();
    expect(soundProblem({ name: 'ping.mp3', type: 'audio/mpeg', size: 200 * 1024 })).toBeNull();
    expect(soundProblem({ name: 'ping.mp3', type: 'audio/mpeg', size: 200 * 1024 + 1 })).toMatch(/200 KB/);
    expect(soundProblem({ name: 'ping.mp3', type: 'audio/mpeg', size: 0 })).toMatch(/vacío/);
    expect(soundProblem({ name: 'ping.wav', type: 'audio/wav', size: 100 })).toMatch(/MP3 \(recomendado\) o un M4A/);
    expect(soundProblem({ name: 'ping.ogg', type: 'audio/ogg', size: 100 })).toMatch(/MP3/);
    expect(soundProblem({ name: 'logo.png', type: 'image/png', size: 100 })).toMatch(/MP3/);
  });
});

describe('Plataforma › Marca (solo Súper Admin)', () => {
  it('la consola tiene «Marca»; sin nada propio muestra los valores por defecto y no ofrece quitar nada', async () => {
    mockApi(server().routes);
    renderApp('/platform/branding');
    expect(await screen.findByRole('link', { name: 'Marca' })).toHaveAttribute('href', '/platform/branding');
    expect(await screen.findByText(/Todavía no subes uno/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subir icono' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Subir logo' })).toHaveLength(2);
    for (const label of ['Quitar icono', 'Quitar logo', 'Restaurar valor por defecto']) expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Requisitos del icono' })).toHaveTextContent(/512 × 512/);
    expect(screen.getByAltText('Icono actual')).toHaveAttribute('src', '/v1/branding/icon-192.png?v=default-1');
    expect(screen.getByRole('img', { name: 'Vista previa de una notificación' })).toHaveTextContent('Sales Smart 2.0');
  });

  describe('nombre', () => {
    it('se guarda con su nombre corto, la pestaña cambia al instante y se puede restaurar', async () => {
      const s = server();
      mockApi(s.routes);
      renderApp('/platform/branding');
      const f = within(await screen.findByRole('form', { name: 'Nombre de la plataforma' }));
      await userEvent.type(f.getByLabelText('Nombre'), 'Mi Marca');
      await userEvent.type(f.getByLabelText('Nombre corto (opcional)'), 'MiMarca');
      await userEvent.click(f.getByRole('button', { name: 'Guardar nombre' }));
      expect(await f.findByText('Nombre guardado.')).toBeInTheDocument();
      expect(s.calls['name']![0]!.body).toEqual({ name: 'Mi Marca', short_name: 'MiMarca' });
      await waitFor(() => expect(document.title).toBe('Marca · Mi Marca')); // «Sección · Nombre», sin recargar
      await userEvent.click(f.getByRole('button', { name: 'Restaurar valor por defecto' }));
      expect(await f.findByText(/Nombre restaurado/)).toBeInTheDocument();
      expect(s.calls['name']![1]!.body).toEqual({ name: null, short_name: null });
      await waitFor(() => expect(document.title).toBe('Marca · Sales Smart 2.0'));
    });

    it('valida antes de mandar: muy corto, con «<», o solo el nombre corto', async () => {
      const s = server();
      mockApi(s.routes);
      renderApp('/platform/branding');
      const f = within(await screen.findByRole('form', { name: 'Nombre de la plataforma' }));
      await userEvent.type(f.getByLabelText('Nombre'), 'A');
      await userEvent.click(f.getByRole('button', { name: 'Guardar nombre' }));
      expect(await f.findByRole('alert')).toHaveTextContent(/de 2 a 40/);
      await userEvent.clear(f.getByLabelText('Nombre'));
      await userEvent.type(f.getByLabelText('Nombre'), 'Mi <b>');
      await userEvent.click(f.getByRole('button', { name: 'Guardar nombre' }));
      expect(await f.findByRole('alert')).toHaveTextContent(/«<» ni «>»/);
      await userEvent.clear(f.getByLabelText('Nombre'));
      await userEvent.type(f.getByLabelText('Nombre corto (opcional)'), 'Corto');
      await userEvent.click(f.getByRole('button', { name: 'Guardar nombre' }));
      expect(await f.findByRole('alert')).toHaveTextContent(/nombre completo/);
      expect(s.calls['name']).toBeUndefined();
    });

    it('si el servidor lo rechaza, muestra el motivo', async () => {
      mockApi(server(EMPTY, { 'PUT /platform/branding': () => err(400, 'BRANDING_NAME_INVALID', 'El nombre debe tener de 2 a 40 caracteres') }).routes);
      renderApp('/platform/branding');
      const f = within(await screen.findByRole('form', { name: 'Nombre de la plataforma' }));
      await userEvent.type(f.getByLabelText('Nombre'), 'Marca');
      await userEvent.click(f.getByRole('button', { name: 'Guardar nombre' }));
      expect(await f.findByText('El nombre debe tener de 2 a 40 caracteres')).toBeInTheDocument();
      expect(f.queryByText('Nombre guardado.')).not.toBeInTheDocument();
    });
  });

  describe('icono de la aplicación', () => {
    it('subir un PNG lo manda tal cual al servidor, muestra el resultado, cambia la vista previa y ofrece cambiarlo o quitarlo', async () => {
      const s = server();
      mockApi(s.routes);
      renderApp('/platform/branding');
      const i = await section('Icono de la aplicación');
      await userEvent.upload(await screen.findByLabelText('Elegir un icono'), file('icono.png', 'image/png', 2048));
      expect(await i.findByText(/Icono actualizado/)).toBeInTheDocument();
      expect(s.puts).toEqual([{ path: 'icon', bytes: 2048, type: 'image/png' }]);
      expect(await i.findByText(/Imagen propia · 1024 × 1024 px/)).toBeInTheDocument();
      expect(i.getByText(/con icono monocromo para Android/)).toBeInTheDocument();
      expect(i.getByAltText('Icono actual')).toHaveAttribute('src', `/v1/branding/icon-192.png?v=${ICON_V}`);
      expect(i.getByRole('button', { name: 'Cambiar icono' })).toBeInTheDocument();
      expect(i.getByRole('button', { name: 'Quitar icono' })).toBeInTheDocument();
    });

    it('si la imagen no tiene transparencia, avisa que no se generó el icono monocromo de Android', async () => {
      const s = server(EMPTY, { 'PUT /platform/branding/icon': () => ({ body: { ...EMPTY, icon: { custom: true, version: ICON_V, px: 600, has_badge: false, updated_at: '2026-11-12T15:00:00.000Z' } } }) });
      mockApi(s.routes);
      renderApp('/platform/branding');
      const i = await section('Icono de la aplicación');
      await userEvent.upload(await screen.findByLabelText('Elegir un icono'), file('icono.png', 'image/png', 2048));
      expect(await i.findByText(/no tiene transparencia: no se pudo generar el icono monocromo/)).toBeInTheDocument();
      expect(i.getByText(/sin icono monocromo/)).toBeInTheDocument();
    });

    it('un SVG, otro formato o más de 1 MB se rechazan en la pantalla sin llamar al servidor', async () => {
      const s = server();
      mockApi(s.routes);
      renderApp('/platform/branding');
      const input = await screen.findByLabelText('Elegir un icono');
      await userEvent.upload(input, file('logo.svg', 'image/svg+xml'), { applyAccept: false });
      expect(await screen.findByText(/No se aceptan archivos SVG/)).toBeInTheDocument();
      await userEvent.upload(input, file('foto.jpg', 'image/jpeg'), { applyAccept: false });
      expect(await screen.findByText(/El icono debe ser un PNG cuadrado/)).toBeInTheDocument();
      await userEvent.upload(input, file('grande.png', 'image/png', 1024 * 1024 + 1));
      expect(await screen.findByText(/máximo es 1 MB/)).toBeInTheDocument();
      expect(s.puts).toEqual([]);
    });

    it('si el servidor rechaza la imagen (no cuadrada, pequeña…), muestra su motivo y no cambia nada', async () => {
      mockApi(server(EMPTY, { 'PUT /platform/branding/icon': () => err(400, 'ICON_NOT_SQUARE', 'El icono debe ser cuadrado (mismo ancho y alto)') }).routes);
      renderApp('/platform/branding');
      await userEvent.upload(await screen.findByLabelText('Elegir un icono'), file('rara.png', 'image/png'));
      expect(await screen.findByText('El icono debe ser cuadrado (mismo ancho y alto)')).toBeInTheDocument();
      expect(screen.getByText(/Todavía no subes uno/)).toBeInTheDocument();
    });

    it('quitar pide confirmación y, al confirmar, vuelve al icono por omisión', async () => {
      const s = server({ ...EMPTY, icon: { custom: true, version: ICON_V, px: 1024, has_badge: true, updated_at: null } });
      mockApi(s.routes);
      renderApp('/platform/branding');
      const i = await section('Icono de la aplicación');
      await userEvent.click(await i.findByRole('button', { name: 'Quitar icono' }));
      await userEvent.click(i.getByRole('button', { name: 'No' }));
      expect(i.queryByRole('group', { name: /Confirmar/ })).not.toBeInTheDocument();
      await userEvent.click(i.getByRole('button', { name: 'Quitar icono' }));
      await userEvent.click(i.getByRole('button', { name: 'Sí, quitar' }));
      expect(await i.findByText(/Icono quitado/)).toBeInTheDocument();
      expect(await i.findByText(/Todavía no subes uno/)).toBeInTheDocument();
    });
  });

  describe('logos', () => {
    it('se suben por separado para fondo claro y oscuro y muestran su vista previa', async () => {
      const s = server();
      mockApi(s.routes);
      renderApp('/platform/branding');
      const light = within(await screen.findByRole('group', { name: 'Logo para fondo claro' }));
      const dark = within(screen.getByRole('group', { name: 'Logo para fondo oscuro' }));
      await userEvent.upload(light.getByLabelText('Elegir el logo para fondo claro'), file('claro.png', 'image/png', 4096));
      expect(await light.findByText('Logo actualizado.')).toBeInTheDocument();
      expect(light.getByAltText('Logo para fondo claro actual')).toHaveAttribute('src', '/v1/branding/logo-light?v=l1');
      expect(light.getByText(/PNG · 400 px de ancho · 4 KB/)).toBeInTheDocument();
      await userEvent.upload(dark.getByLabelText('Elegir el logo para fondo oscuro'), file('oscuro.webp', 'image/webp', 3072));
      expect(await dark.findByText('Logo actualizado.')).toBeInTheDocument();
      expect(dark.getByText(/WebP · 300 px de ancho/)).toBeInTheDocument();
      expect(s.puts.map((p) => [p.path, p.type])).toEqual([['logo-light', 'image/png'], ['logo-dark', 'image/webp']]);
    });

    it('rechaza SVG y formatos que no son PNG ni WebP sin llamar al servidor, y muestra el motivo del servidor si lo rechaza', async () => {
      const s = server(EMPTY, { 'PUT /platform/branding/logo-dark': () => err(400, 'LOGO_TOO_WIDE', 'El logo puede tener hasta 1024 px de ancho') });
      mockApi(s.routes);
      renderApp('/platform/branding');
      const light = within(await screen.findByRole('group', { name: 'Logo para fondo claro' }));
      await userEvent.upload(light.getByLabelText('Elegir el logo para fondo claro'), file('x.svg', 'image/svg+xml'), { applyAccept: false });
      expect(await light.findByText(/No se aceptan archivos SVG/)).toBeInTheDocument();
      await userEvent.upload(light.getByLabelText('Elegir el logo para fondo claro'), file('x.jpg', 'image/jpeg'), { applyAccept: false });
      expect(await light.findByText(/PNG o un WebP/)).toBeInTheDocument();
      expect(s.puts).toEqual([]);
      const dark = within(screen.getByRole('group', { name: 'Logo para fondo oscuro' }));
      await userEvent.upload(dark.getByLabelText('Elegir el logo para fondo oscuro'), file('ancho.png', 'image/png'));
      expect(await dark.findByText('El logo puede tener hasta 1024 px de ancho')).toBeInTheDocument();
    });

    it('quitar un logo pide confirmación', async () => {
      const s = server({ ...EMPTY, logo_light: { version: 'l1', bytes: 4096, content_type: 'image/png', px: 400 } });
      mockApi(s.routes);
      renderApp('/platform/branding');
      const light = within(await screen.findByRole('group', { name: 'Logo para fondo claro' }));
      await userEvent.click(light.getByRole('button', { name: 'Quitar logo' }));
      await userEvent.click(light.getByRole('button', { name: 'Sí, quitar' }));
      expect(await light.findByText('Logo quitado.')).toBeInTheDocument();
      expect(light.getByRole('button', { name: 'Subir logo' })).toBeInTheDocument();
    });
  });

  describe('sonido de notificación', () => {
    const mp3 = (size = 30 * 1024) => file('ping.mp3', 'audio/mpeg', size);
    const WITH_SOUND: BrandingView = { ...EMPTY, sound: { version: SOUND_V, bytes: 30 * 1024, content_type: 'audio/mpeg' } };

    it('sin sonido propio muestra los requisitos y las limitaciones, deja probar el tono y no ofrece restaurar', async () => {
      mockApi(server().routes);
      renderApp('/platform/branding');
      const w = await section('Sonido de notificación');
      expect(await w.findByText(/Sin sonido propio: se usa el tono por omisión/)).toBeInTheDocument();
      const req = w.getByRole('list', { name: 'Requisitos del sonido' });
      expect(req).toHaveTextContent(/MP3 \(recomendado\) o M4A \(AAC\), a 128 kbps/);
      expect(req).toHaveTextContent(/de 1 a 3 segundos/);
      expect(req).toHaveTextContent(/hasta 100 KB recomendado; el máximo aceptado es 200 KB/);
      const lim = w.getByRole('list', { name: 'Limitaciones del sonido' });
      expect(lim).toHaveTextContent(/aplicación cerrada.*sonido del sistema/);
      expect(lim).toHaveTextContent(/hasta que la persona la toca una vez/);
      expect(w.getByRole('button', { name: 'Subir sonido' })).toBeInTheDocument();
      expect(w.queryByRole('button', { name: 'Restaurar sonido por defecto' })).not.toBeInTheDocument();
      vi.mocked(testSound).mockResolvedValue('ok');
      await userEvent.click(w.getByRole('button', { name: 'Probar sonido' }));
      await waitFor(() => expect(testSound).toHaveBeenCalledWith(null));
    });

    it('subir un MP3 lo manda tal cual, muestra el resultado y la marca de la interfaz recibe la dirección del sonido', async () => {
      const s = server();
      mockApi(s.routes);
      renderApp('/platform/branding');
      const w = await section('Sonido de notificación');
      await userEvent.upload(await screen.findByLabelText('Elegir un sonido'), mp3());
      expect(await w.findByText(/Sonido actualizado/)).toBeInTheDocument();
      expect(s.puts).toEqual([{ path: 'sound', bytes: 30 * 1024, type: 'audio/mpeg' }]);
      expect(await w.findByText(/Sonido propio · MP3 · 30 KB/)).toBeInTheDocument();
      expect(w.getByRole('button', { name: 'Cambiar sonido' })).toBeInTheDocument();
      expect(w.getByRole('button', { name: 'Restaurar sonido por defecto' })).toBeInTheDocument();
      await waitFor(() => expect(getBrand().sound).toBe(`/v1/branding/sound?v=${SOUND_V}`));
    });

    it('«Probar sonido» con sonido propio toca ese archivo (con su versión) y explica si no se pudo', async () => {
      mockApi(server(WITH_SOUND).routes);
      renderApp('/platform/branding');
      const w = await section('Sonido de notificación');
      vi.mocked(testSound).mockResolvedValueOnce('ok').mockResolvedValueOnce('error').mockResolvedValueOnce('unsupported');
      await userEvent.click(await w.findByRole('button', { name: 'Probar sonido' }));
      await waitFor(() => expect(testSound).toHaveBeenCalledWith(`/v1/branding/sound?v=${SOUND_V}`));
      expect(w.queryByRole('alert')).not.toBeInTheDocument();
      await userEvent.click(w.getByRole('button', { name: 'Probar sonido' }));
      expect(await w.findByRole('alert')).toHaveTextContent(/No se pudo reproducir el sonido/);
      await userEvent.click(w.getByRole('button', { name: 'Probar sonido' }));
      await waitFor(() => expect(w.getByRole('alert')).toHaveTextContent(/no puede reproducir audio/));
    });

    it('rechaza en la pantalla otros formatos y más de 200 KB, sin llamar al servidor', async () => {
      const s = server();
      mockApi(s.routes);
      renderApp('/platform/branding');
      const w = await section('Sonido de notificación');
      const input = await screen.findByLabelText('Elegir un sonido');
      await userEvent.upload(input, file('ping.wav', 'audio/wav'), { applyAccept: false });
      expect(await w.findByText(/No se aceptan WAV, OGG ni otros formatos/)).toBeInTheDocument();
      await userEvent.upload(input, mp3(200 * 1024 + 1));
      expect(await w.findByText(/el máximo es 200 KB/)).toBeInTheDocument();
      expect(s.puts).toEqual([]);
    });

    it('si el servidor rechaza el archivo (por ejemplo un MP3 falso), muestra su motivo y no cambia nada', async () => {
      mockApi(server(EMPTY, { 'PUT /platform/branding/sound': () => err(400, 'SOUND_FORMAT_INVALID', 'El sonido debe ser un MP3 (recomendado) o un M4A (AAC) válido: el contenido del archivo no corresponde a ninguno de los dos') }).routes);
      renderApp('/platform/branding');
      const w = await section('Sonido de notificación');
      await userEvent.upload(await screen.findByLabelText('Elegir un sonido'), mp3());
      expect(await w.findByText(/el contenido del archivo no corresponde a ninguno de los dos/)).toBeInTheDocument();
      expect(w.getByText(/Sin sonido propio/)).toBeInTheDocument();
    });

    it('avisa (sin impedir la subida) si el archivo dura más de 5 s', async () => {
      class FakeOffline {
        decodeAudioData(): Promise<{ duration: number }> {
          return Promise.resolve({ duration: 7.2 });
        }
      }
      vi.stubGlobal('OfflineAudioContext', FakeOffline);
      const s = server();
      mockApi(s.routes);
      renderApp('/platform/branding');
      const w = await section('Sonido de notificación');
      await userEvent.upload(await screen.findByLabelText('Elegir un sonido'), mp3());
      expect(await w.findByText(/dura 7\.2 s/)).toBeInTheDocument();
      expect(await w.findByText(/Sonido actualizado/)).toBeInTheDocument();
      expect(s.puts).toHaveLength(1);
    });

    it('restaurar pide confirmación y, al confirmar, vuelve al tono por omisión', async () => {
      const s = server(WITH_SOUND);
      mockApi(s.routes);
      renderApp('/platform/branding');
      const w = await section('Sonido de notificación');
      await userEvent.click(await w.findByRole('button', { name: 'Restaurar sonido por defecto' }));
      await userEvent.click(w.getByRole('button', { name: 'No' }));
      expect(w.queryByRole('group', { name: /Confirmar/ })).not.toBeInTheDocument();
      await userEvent.click(w.getByRole('button', { name: 'Restaurar sonido por defecto' }));
      await userEvent.click(w.getByRole('button', { name: 'Sí, quitar' }));
      expect(await w.findByText(/Sonido quitado/)).toBeInTheDocument();
      expect(await w.findByText(/Sin sonido propio/)).toBeInTheDocument();
    });
  });

  describe('notificaciones', () => {
    it.each([
      ['ok', /debería aparecer una notificación del sistema/],
      ['denied', /permiso de notificaciones está bloqueado/],
      ['unsupported', /no permite notificaciones/],
      ['error', /No se pudo mostrar la notificación/],
    ] as const)('«Probar notificación» con resultado «%s» explica qué pasó', async (result, text) => {
      mockApi(server().routes);
      vi.mocked(showTestNotification).mockResolvedValue(result);
      renderApp('/platform/branding');
      const n = await section('Notificaciones');
      await userEvent.click(n.getByRole('button', { name: 'Probar notificación en este navegador' }));
      expect(await n.findByText(text)).toBeInTheDocument();
      expect(showTestNotification).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sales Smart 2.0' }));
    });
  });
});
