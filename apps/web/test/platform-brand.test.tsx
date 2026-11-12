import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBrand, parseBrand, refreshBrand, resetBrand, setBrand, titleFor } from '../src/lib/platformBrand';
import { Logo } from '../src/ui/AuthShell';

const putBlock = (data: unknown): void => {
  document.getElementById('brand-data')?.remove();
  const el = document.createElement('script');
  el.id = 'brand-data';
  el.type = 'application/json';
  el.textContent = typeof data === 'string' ? data : JSON.stringify(data);
  document.head.appendChild(el);
};

beforeEach(() => {
  vi.unstubAllGlobals();
  document.getElementById('brand-data')?.remove();
  document.head.querySelectorAll('link[rel="icon"]').forEach((l) => l.remove());
  resetBrand();
});

describe('parseBrand: solo se acepta lo que tiene la forma esperada', () => {
  it('sin datos o con basura cae a los valores por defecto', () => {
    for (const raw of [undefined, null, 5, 'x', [], {}]) expect(parseBrand(raw)).toMatchObject({ name: 'Sales Smart 2.0', shortName: null, version: 'default-1', iconCustom: false, icon192: null });
    expect(parseBrand({}).logo).toEqual({ light: null, dark: null });
  });
  it('lee nombre, logos e icono propios', () => {
    expect(parseBrand({ name: 'Mi Marca', short_name: 'MiMarca', version: 'v7', logo: { light: '/v1/branding/logo-light?v=a', dark: '/v1/branding/logo-dark?v=b' }, icon: { custom: true, icon_192: '/v1/branding/icon-192.png?v=v7', badge_96: '/v1/branding/badge-96.png?v=v7' } })).toEqual({
      name: 'Mi Marca', shortName: 'MiMarca', version: 'v7', logo: { light: '/v1/branding/logo-light?v=a', dark: '/v1/branding/logo-dark?v=b' }, iconCustom: true, icon192: '/v1/branding/icon-192.png?v=v7', badge96: '/v1/branding/badge-96.png?v=v7',
    });
  });
  it('una dirección que no es de la propia aplicación (otro sitio, javascript:, protocolo relativo) se descarta', () => {
    const b = parseBrand({ name: 'X', logo: { light: 'https://evil.test/x.png', dark: '//evil.test/x.png' }, icon: { custom: true, icon_192: 'javascript:alert(1)', badge_96: '/otra/ruta.png' } });
    expect(b.logo).toEqual({ light: null, dark: null });
    expect(b.icon192).toBeNull();
    expect(b.badge96).toBeNull();
  });
});

describe('la marca que escribe el servidor en el HTML', () => {
  it('se lee del bloque de datos al arrancar; sin bloque o con JSON roto se usan los valores por defecto', () => {
    putBlock({ name: 'Mi Marca', version: 'v1', logo: { light: null, dark: '/v1/branding/logo-dark?v=d' }, icon: null });
    resetBrand();
    expect(getBrand()).toMatchObject({ name: 'Mi Marca', version: 'v1', logo: { dark: '/v1/branding/logo-dark?v=d' } });
    putBlock('{ esto no es json');
    resetBrand();
    expect(getBrand().name).toBe('Sales Smart 2.0');
    document.getElementById('brand-data')?.remove();
    resetBrand();
    expect(getBrand().name).toBe('Sales Smart 2.0');
  });
});

describe('Logo (menú lateral y pantallas de acceso)', () => {
  it('sin marca propia se ve como siempre: «Sales Smart» con su etiqueta 2.0', () => {
    render(<Logo />);
    expect(screen.getByText('2.0')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('con un nombre propio muestra la inicial y el nombre, sin la etiqueta 2.0', () => {
    setBrand({ ...getBrand(), name: 'Mi Marca' });
    render(<Logo />);
    expect(screen.getByText('Mi Marca')).toBeInTheDocument();
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.queryByText('2.0')).not.toBeInTheDocument();
  });

  it('con logos propios muestra la imagen del fondo pedido (oscuro por omisión) y usa el otro si falta uno', () => {
    setBrand({ ...getBrand(), name: 'Mi Marca', logo: { light: '/v1/branding/logo-light?v=a', dark: '/v1/branding/logo-dark?v=b' } });
    const { rerender } = render(<Logo />);
    expect(screen.getByAltText('Mi Marca')).toHaveAttribute('src', '/v1/branding/logo-dark?v=b');
    rerender(<Logo surface="light" />);
    expect(screen.getByAltText('Mi Marca')).toHaveAttribute('src', '/v1/branding/logo-light?v=a');
    act(() => setBrand({ ...getBrand(), logo: { light: '/v1/branding/logo-light?v=a', dark: null } }));
    rerender(<Logo />);
    expect(screen.getByAltText('Mi Marca')).toHaveAttribute('src', '/v1/branding/logo-light?v=a');
  });

  it('cuando cambia la marca, el logo se actualiza solo', () => {
    render(<Logo />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    act(() => setBrand({ ...getBrand(), logo: { light: null, dark: '/v1/branding/logo-dark?v=z' } }));
    expect(screen.getByRole('img')).toHaveAttribute('src', '/v1/branding/logo-dark?v=z');
  });
});

describe('título de la pestaña y refresco de la marca', () => {
  it('«Sección · Nombre»; sin sección, solo el nombre', () => {
    expect(titleFor('Inbox', 'Mi Marca')).toBe('Inbox · Mi Marca');
    expect(titleFor('  ', 'Mi Marca')).toBe('Mi Marca');
    expect(titleFor(null, 'Mi Marca')).toBe('Mi Marca');
    expect(titleFor(undefined, 'Mi Marca')).toBe('Mi Marca');
  });

  it('refreshBrand vuelve a pedir la marca, actualiza la interfaz y el icono de esta pestaña; un fallo deja lo que había', async () => {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = '/v1/branding/favicon';
    document.head.appendChild(link);
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ name: 'Otra Marca', version: 'v9', logo: { light: null, dark: null }, icon: { custom: true, icon_192: '/v1/branding/icon-192.png?v=v9', badge_96: '/v1/branding/badge-96.png?v=v9' } }), { status: 200 })));
    await refreshBrand();
    expect(getBrand()).toMatchObject({ name: 'Otra Marca', version: 'v9', iconCustom: true });
    expect(link.getAttribute('href')).toBe('/v1/branding/favicon?v=v9');
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 500 })));
    await refreshBrand();
    expect(getBrand().name).toBe('Otra Marca');
    vi.stubGlobal('fetch', () => Promise.reject(new Error('sin red')));
    await refreshBrand();
    expect(getBrand().name).toBe('Otra Marca');
  });
});

// ---- el service worker: las notificaciones llevan el icono y el badge de la marca (causa del icono ausente: `showNotification` no los pasaba)
type Evt = { data?: { json(): unknown }; waitUntil(p: Promise<unknown>): void };
type Handler = (e: Evt) => void;

function loadWorker(fetchImpl: (url: string) => Promise<Response>, visible = false) {
  const handlers: Record<string, Handler> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const fetches: string[] = [];
  const self = {
    addEventListener: (type: string, fn: Handler) => { handlers[type] = fn; },
    skipWaiting: () => undefined,
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve(visible ? [{ visibilityState: 'visible', focused: true }] : []) },
    registration: { showNotification: (title: string, options: Record<string, unknown>) => { shown.push({ title, options }); return Promise.resolve(); } },
    location: { origin: 'https://app.test' },
  };
  const sandbox = { self, fetch: (url: string) => { fetches.push(url); return fetchImpl(url); }, URL, Date, Promise };
  vm.runInNewContext(readFileSync(path.resolve(__dirname, '../public/sw.js'), 'utf8'), sandbox);
  const push = async (payload: Record<string, unknown>): Promise<void> => {
    const waits: Array<Promise<unknown>> = [];
    handlers['push']!({ data: { json: () => payload }, waitUntil: (p) => { waits.push(p); } });
    await Promise.all(waits);
  };
  return { push, shown, fetches };
}
const brandReply = (b: unknown) => () => Promise.resolve(new Response(JSON.stringify(b), { status: 200 }));
const BRAND = { name: 'Mi Marca', icon: { custom: true, icon_192: '/v1/branding/icon-192.png?v=v5', badge_96: '/v1/branding/badge-96.png?v=v5' } };

describe('service worker de notificaciones', () => {
  it('muestra la notificación con el icono y el badge versionados de la marca, y el nombre como título por omisión', async () => {
    const w = loadWorker(brandReply(BRAND));
    await w.push({ body: 'Hola', url: '/inbox/c1', tag: 'conv-1' });
    expect(w.fetches).toEqual(['/v1/branding']);
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]).toMatchObject({ title: 'Mi Marca', options: { body: 'Hola', icon: '/v1/branding/icon-192.png?v=v5', badge: '/v1/branding/badge-96.png?v=v5', tag: 'conv-1', renotify: true, data: { url: '/inbox/c1' } } });
  });

  it('respeta el título que manda el servidor', async () => {
    const w = loadWorker(brandReply(BRAND));
    await w.push({ title: 'Luis Navas', body: 'Hola' });
    expect(w.shown[0]!.title).toBe('Luis Navas');
  });

  it('si la marca no se puede leer, usa las direcciones sin versión (el servidor siempre responde con una imagen)', async () => {
    const failures: Array<() => Promise<Response>> = [() => Promise.reject(new Error('sin red')), () => Promise.resolve(new Response('{}', { status: 500 })), () => Promise.resolve(new Response('no es json', { status: 200 }))];
    for (const impl of failures) {
      const w = loadWorker(impl);
      await w.push({ body: 'Hola' });
      expect(w.shown[0]).toMatchObject({ title: 'Sales Smart', options: { icon: '/v1/branding/icon-192.png', badge: '/v1/branding/badge-96.png' } });
    }
  });

  it('una dirección de otro sitio en la respuesta no se usa como icono', async () => {
    const w = loadWorker(brandReply({ name: 'X', icon: { icon_192: 'https://evil.test/i.png', badge_96: '//evil.test/b.png' } }));
    await w.push({ body: 'Hola' });
    expect(w.shown[0]!.options).toMatchObject({ icon: '/v1/branding/icon-192.png', badge: '/v1/branding/badge-96.png' });
  });

  it('guarda la marca unos minutos: dos avisos seguidos piden la marca una sola vez', async () => {
    const w = loadWorker(brandReply(BRAND));
    await w.push({ body: 'Uno' });
    await w.push({ body: 'Dos' });
    expect(w.fetches).toHaveLength(1);
    expect(w.shown).toHaveLength(2);
  });

  it('con la aplicación a la vista no repite la notificación, salvo la de prueba (force)', async () => {
    const w = loadWorker(brandReply(BRAND), true);
    await w.push({ body: 'Hola' });
    expect(w.shown).toHaveLength(0);
    await w.push({ body: 'Prueba', force: true });
    expect(w.shown).toHaveLength(1);
  });
});
