import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNavGroups, isChatPath } from '../src/features/app/navGroups';
import { BottomNav } from '../src/ui/BottomNav';
import { breakpointOf, DESKTOP_MIN, MOBILE_MAX } from '../src/ui/breakpoints';
import { layoutKey, parseLayout, readLayout, writeLayout } from '../src/ui/layoutStore';
import { applyThemeMode, parseThemeMode, readThemeMode, setThemeMode, THEME_KEY } from '../src/ui/theme';
import { ThemeSwitch } from '../src/ui/ThemeSwitch';
import { authed, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, trial } from './helpers';

/** `matchMedia` de mentira para un ancho dado (jsdom no lo trae): responde a los cortes de `ui/breakpoints.ts` y al tema del sistema. */
function stubWidth(width: number, dark = false): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    const min = /min-width:\s*(\d+)px/.exec(q);
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : q.includes('prefers-color-scheme: dark') ? dark : false;
    return { matches, media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false };
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetWorld();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => vi.unstubAllGlobals());

const manage = (access: boolean) => ({ 'GET /custom-fields': () => ({ body: { items: [], access: { manage: access } } }) });

describe('cortes de pantalla (un solo origen)', () => {
  it('móvil hasta 767, tablet 768–1279, escritorio desde 1280', () => {
    expect(MOBILE_MAX).toBe(767);
    expect(DESKTOP_MIN).toBe(1280);
    expect([360, 767].map(breakpointOf)).toEqual(['mobile', 'mobile']);
    expect([768, 1024, 1279].map(breakpointOf)).toEqual(['tablet', 'tablet', 'tablet']);
    expect([1280, 1920].map(breakpointOf)).toEqual(['desktop', 'desktop']);
  });

  it('coinciden con `md` (768) y `xl` (1280) de Tailwind: el CSS no redefine los cortes', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).not.toMatch(/--breakpoint-/);
    expect(MOBILE_MAX + 1).toBe(768);
  });
});

describe('tema claro / oscuro / sistema', () => {
  it('lo guardado se valida: solo claro u oscuro; cualquier otra cosa es «sistema»', () => {
    expect(parseThemeMode('dark')).toBe('dark');
    expect(parseThemeMode('light')).toBe('light');
    expect(parseThemeMode('azul')).toBe('system');
    expect(parseThemeMode(null)).toBe('system');
  });

  it('elegir guarda la preferencia y pone data-theme; «sistema» las quita (manda el aparato)', () => {
    setThemeMode('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(readThemeMode()).toBe('dark');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark');
    setThemeMode('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    applyThemeMode('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('el interruptor es un role=switch con texto, cambia a oscuro y se puede volver al sistema', async () => {
    stubWidth(1440);
    render(<ThemeSwitch />);
    const sw = screen.getByRole('switch', { name: 'Modo oscuro' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(screen.getByRole('switch', { name: 'Modo claro' })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await userEvent.click(screen.getByRole('button', { name: 'Sistema' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('el script previo al primer pintado existe, es un archivo propio (el CSP no admite scripts en línea) y usa la misma clave', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('<script src="/theme-init.js"></script>');
    const js = readFileSync(resolve(process.cwd(), 'public/theme-init.js'), 'utf8');
    expect(js).toContain(THEME_KEY);
  });
});

describe('distribución guardada por persona y empresa', () => {
  it('la clave lleva a la persona y a la empresa, y nunca se mezclan', () => {
    expect(layoutKey('u1', 'o1')).toBe('ss.inbox.layout.v1:u1:o1');
    writeLayout('u1', 'o1', { sidebar: 'collapsed' });
    expect(readLayout('u1', 'o1')).toEqual({ sidebar: 'collapsed' });
    expect(readLayout('u1', 'o2')).toEqual({});
    expect(readLayout('u2', 'o1')).toEqual({});
  });

  it('un valor roto o raro nunca rompe: se ignora', () => {
    expect(parseLayout('{no es json')).toEqual({});
    expect(parseLayout('[1,2]')).toEqual({});
    expect(parseLayout('{"sidebar":"enorme"}')).toEqual({});
    expect(parseLayout(null)).toEqual({});
  });
});

describe('secciones (una sola definición)', () => {
  it('reconoce una conversación individual, no las listas del Inbox', () => {
    expect(isChatPath('/inbox/7f3a')).toBe(true);
    expect(isChatPath('/inbox')).toBe(false);
    expect(isChatPath('/inbox/scheduled')).toBe(false);
    expect(isChatPath('/contacts')).toBe(false);
  });

  it('el administrador ve las secciones de gestión; las de quien no administra no incluyen Formularios, Agentes, Usuarios ni Configuración', () => {
    const labels = (admin: boolean) => buildNavGroups({ admin, unread: 0 }).flatMap((g) => g.items.map((i) => i.label));
    expect(labels(true)).toEqual(expect.arrayContaining(['Formularios', 'Agentes IA', 'Usuarios', 'Configuración']));
    expect(labels(false)).not.toEqual(expect.arrayContaining(['Formularios']));
    expect(labels(false)).not.toContain('Configuración');
    expect(labels(false)).toEqual(expect.arrayContaining(['Inicio', 'Inbox', 'Agenda', 'Ventas']));
  });
});

describe('barra inferior', () => {
  const bar = (pathname: string, groups = buildNavGroups({ admin: false, unread: 0 }), unread = 0) =>
    render(<MemoryRouter initialEntries={[pathname]}><BottomNav groups={groups} pathname={pathname} unread={unread} /></MemoryRouter>);

  it('Inicio · Calendario · Ventas · Inbox · Menú, en ese orden y sin botón central', () => {
    bar('/');
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Inicio', 'Calendario', 'Ventas', 'Inbox', 'Menú']);
  });

  it('el activo lleva aria-current; «Menú» queda activo si la sección no es una de las cuatro', () => {
    const { unmount } = bar('/sales');
    expect(screen.getByRole('link', { name: 'Ventas' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Menú' })).not.toHaveAttribute('aria-current');
    unmount();
    bar('/contacts');
    expect(screen.getByRole('link', { name: 'Menú' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Inicio' })).not.toHaveAttribute('aria-current');
  });

  it('un acceso que la persona no tiene en el menú no aparece; el Menú siempre está', () => {
    const sinVentas = buildNavGroups({ admin: false, unread: 0 }).map((g) => ({ ...g, items: g.items.filter((i) => i.to !== '/sales') }));
    bar('/', sinVentas);
    const names = within(screen.getByRole('navigation', { name: 'Navegación principal' })).getAllByRole('link').map((a) => a.textContent);
    expect(names).toEqual(['Inicio', 'Calendario', 'Inbox', 'Menú']);
  });

  it('la insignia de no leídos tiene texto accesible y tope «99+»', () => {
    const { unmount } = bar('/', undefined, 3);
    expect(screen.getByRole('link', { name: 'Inbox, 3 sin leer' })).toBeInTheDocument();
    unmount();
    bar('/', undefined, 250);
    expect(screen.getByRole('link', { name: 'Inbox, más de 99 sin leer' })).toHaveTextContent('99+');
  });
});

describe('marco de la empresa por tamaño de pantalla', () => {
  it('móvil: barra inferior y Menú; no hay panel lateral visible ni botón ☰', async () => {
    stubWidth(390);
    mockApi({ ...authed(ME_ADMIN, trial()), ...manage(false) });
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Navegación principal' });
    expect(within(nav).getAllByRole('link')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Abrir el menú' })).not.toBeInTheDocument();
  });

  it('móvil: dentro de una conversación (/inbox/:id) la barra inferior no existe', async () => {
    stubWidth(390);
    mockApi({ ...authed(ME_ADMIN, trial()), ...manage(false) });
    renderApp('/inbox/abc');
    await screen.findByRole('complementary', { name: 'Menú principal', hidden: true });
    expect(screen.queryByRole('navigation', { name: 'Navegación principal' })).not.toBeInTheDocument();
  });

  it('móvil: /menu muestra las secciones en cuadrícula; Configuración y Cerrar sesión van al final', async () => {
    stubWidth(390);
    mockApi({ ...authed(ME_ADMIN, trial()), ...manage(true) });
    renderApp('/menu');
    const grid = await screen.findByRole('navigation', { name: 'Todas las secciones' });
    await within(grid).findByRole('link', { name: 'Formularios' });
    const names = within(grid).getAllByRole('link').map((a) => a.textContent);
    expect(names).toEqual(expect.arrayContaining(['Inicio', 'Inbox', 'Ventas', 'Formularios', 'Agentes IA', 'Usuarios', 'Analítica']));
    expect(names).not.toContain('Configuración');
    const footer = screen.getByRole('region', { name: 'Cuenta y ajustes' });
    expect(within(footer).getByRole('link', { name: 'Configuración' })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Tu cuenta' })).getByRole('switch', { name: 'Modo oscuro' })).toBeInTheDocument();
  });

  it('móvil: un asesor solo ve las secciones permitidas', async () => {
    stubWidth(390);
    mockApi({ ...authed(ME_ADVISOR, trial()), ...manage(false) });
    renderApp('/menu');
    const grid = await screen.findByRole('navigation', { name: 'Todas las secciones' });
    const names = within(grid).getAllByRole('link').map((a) => a.textContent);
    expect(names).toEqual(expect.arrayContaining(['Inicio', 'Inbox', 'Contactos']));
    expect(names).not.toEqual(expect.arrayContaining(['Formularios']));
    expect(names).not.toEqual(expect.arrayContaining(['Usuarios']));
    expect(screen.queryByRole('link', { name: 'Configuración' })).not.toBeInTheDocument();
  });

  it('escritorio: sin barra inferior, con el menú lateral, y /menu vuelve al inicio', async () => {
    stubWidth(1440);
    mockApi({ ...authed(ME_ADMIN, trial()), ...manage(false) });
    renderApp('/menu');
    await screen.findByRole('navigation', { name: 'Secciones' });
    expect(screen.queryByRole('navigation', { name: 'Navegación principal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Todas las secciones' })).not.toBeInTheDocument();
  });

  it('barra lateral: se pliega a iconos, los enlaces conservan su nombre y la preferencia se guarda por persona y empresa', async () => {
    stubWidth(1440);
    mockApi({ ...authed(ME_ADMIN, trial()), ...manage(false) });
    renderApp('/');
    const toggle = await screen.findByRole('button', { name: 'Plegar el menú' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    const folded = screen.getByRole('button', { name: 'Desplegar el menú' });
    expect(folded).toHaveAttribute('aria-expanded', 'false');
    expect(within(screen.getByRole('navigation', { name: 'Secciones' })).getByRole('link', { name: 'Inbox' })).toHaveAttribute('title', 'Inbox');
    expect(readLayout(ME_ADMIN.user.id, ME_ADMIN.organization.id)).toEqual({ sidebar: 'collapsed' });
    expect(readLayout(ME_ADVISOR.user.id, ME_ADVISOR.organization.id)).toEqual({});
  });

  it('barra lateral: en tablet nace plegada', async () => {
    stubWidth(1000);
    mockApi({ ...authed(ME_ADMIN, trial()), ...manage(false) });
    renderApp('/');
    expect(await screen.findByRole('button', { name: 'Desplegar el menú' })).toBeInTheDocument();
  });
});
