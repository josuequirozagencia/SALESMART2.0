import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact, ContactAccess, CrmCompany, SavedList } from '../src/lib/types';
import { authed, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

// M10.2 — Empresas dentro de Contactos: columna opcional «Empresa», filtro por empresa (también en listas guardadas) y exportación.
beforeEach(() => {
  vi.unstubAllGlobals();
  resetWorld();
  window.localStorage.clear();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:fake');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

const ALL: ContactAccess = { view_all: true, write: true, delete: true, import: true, export: true };
const NOW = '2026-10-10T15:00:00.000Z';
const co = (id: string, name: string, n: number): CrmCompany => ({ id, name, website: null, phone: null, email: null, contact_count: n, created_at: NOW, updated_at: NOW });
const ACME = co('k1', 'Acme SA', 2);
const LUNA = co('k2', 'Estudio Luna', 1);
const contact = (id: string, name: string, companies: Contact['companies']): Contact => ({
  id, name, email: `${id}@correo.test`, phones: [{ e164: '+593984217730', primary: true }], owner: null, source: 'manual', consent: 'unknown', consent_updated_at: null, custom_fields: {}, tags: [], companies, attribution: null, created_at: NOW, updated_at: NOW,
});
const ANA = contact('c1', 'Ana Torres', [{ id: 'k1', name: 'Acme SA' }]);
const BETO = contact('c2', 'Beto Luna', [{ id: 'k1', name: 'Acme SA' }, { id: 'k2', name: 'Estudio Luna' }]);
const CATA = contact('c3', 'Cata Sin', []);
const ALL_CONTACTS = [ANA, BETO, CATA];

interface World { routes: Record<string, Handler>; contactQueries: URLSearchParams[]; posts: Call[]; exports: Call[]; lists: SavedList[] }
function world(initial: SavedList[] = []): World {
  const w: World = { routes: {}, contactQueries: [], posts: [], exports: [], lists: [...initial] };
  w.routes = {
    ...authed(ME_ADMIN),
    'GET /contacts': (call) => {
      w.contactQueries.push(call.query);
      const c = call.query.get('company');
      const items = c ? ALL_CONTACTS.filter((x) => x.companies.some((y) => y.id === c)) : ALL_CONTACTS;
      return { body: { items, next_cursor: null, total: items.length, access: ALL } };
    },
    'GET /contacts/owners': () => ({ body: { items: [] } }),
    'GET /tags': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /contact-lists': () => ({ body: { items: w.lists } }),
    'GET /companies': (call) => {
      const q = call.query.get('q')?.toLowerCase();
      return { body: { items: [ACME, LUNA].filter((c) => !q || c.name.toLowerCase().includes(q)), next_cursor: null, access: { manage: true, write: true } } };
    },
    'GET /companies/k1': () => ({ body: ACME }),
    'POST /contact-lists': (call) => {
      w.posts.push(call);
      const b = call.body as Partial<SavedList>;
      const made: SavedList = { id: 'l9', name: b.name ?? 'x', kind: 'dynamic', filters: b.filters ?? {}, columns: b.columns ?? null, sort: b.sort ?? null, shared: false, mine: true, member_count: null, created_at: NOW, updated_at: NOW };
      w.lists = [...w.lists, made];
      return { status: 201, body: made };
    },
    'POST /contacts/export': (call) => { w.exports.push(call); return { text: '﻿Nombre\r\nAna Torres\r\n', headers: { 'content-disposition': 'attachment; filename="contactos.csv"', 'x-export-count': '2' } }; },
  };
  return w;
}
const table = async () => within(await screen.findByRole('table', { name: 'Contactos' }));

describe('Contactos · columna «Empresa»', () => {
  it('es una columna opcional (no está por omisión) que se añade desde «Columnas» y muestra las empresas de cada contacto', async () => {
    mockApi(world().routes);
    renderApp('/contacts');
    let t = await table();
    expect(t.queryByRole('columnheader', { name: 'Empresa' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Columnas/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Columnas de la tabla' })).getByLabelText('Empresa'));
    t = await table();
    expect(t.getByRole('columnheader', { name: 'Empresa' })).toBeInTheDocument();
    const beto = within(t.getByRole('button', { name: 'Abrir el contacto Beto Luna' }).closest('tr')!);
    expect(beto.getByText('Acme SA, Estudio Luna')).toBeInTheDocument();
    const cata = within(t.getByRole('button', { name: 'Abrir el contacto Cata Sin' }).closest('tr')!);
    expect(cata.getAllByText('—').length).toBeGreaterThan(0); // sin empresa: guion (como las demás columnas vacías)
    // se recuerda en el navegador
    expect(JSON.parse(window.localStorage.getItem('ss:contacts:columns') ?? '[]')).toContain('company');
  });
});

describe('Contactos · filtro por empresa', () => {
  it('se busca la empresa, se elige y el listado pide company=<id>; queda como etiqueta que se quita con la ×', async () => {
    const w = world();
    mockApi(w.routes);
    renderApp('/contacts');
    expect(await (await table()).findByText('Cata Sin')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Filtrar por empresa'), 'acme');
    await userEvent.click(await screen.findByRole('button', { name: 'Filtrar por la empresa Acme SA' }));
    await waitFor(() => expect(w.contactQueries.at(-1)!.get('company')).toBe('k1'));
    const t = await table();
    await waitFor(() => expect(t.queryByText('Cata Sin')).toBeNull());
    expect(t.getByText('Ana Torres')).toBeInTheDocument();
    expect(screen.getByText('2 contactos con estos filtros')).toBeInTheDocument();
    const chips = within(screen.getByRole('list', { name: 'Filtros activos' }));
    expect(chips.getByText('Empresa: Acme SA')).toBeInTheDocument();
    await userEvent.click(chips.getByRole('button', { name: 'Quitar el filtro Empresa: Acme SA' }));
    await waitFor(() => expect(w.contactQueries.at(-1)!.get('company')).toBeNull());
    expect(await (await table()).findByText('Cata Sin')).toBeInTheDocument();
  });

  it('una lista dinámica guarda el filtro por empresa; al abrirla se aplica y la etiqueta trae el nombre del servidor', async () => {
    const w = world([{ id: 'l1', name: 'De Acme', kind: 'dynamic', filters: { company: 'k1' }, columns: null, sort: null, shared: false, mine: true, member_count: null, created_at: NOW, updated_at: NOW }]);
    mockApi(w.routes);
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('tab', { name: /De Acme/ }));
    await waitFor(() => expect(w.contactQueries.at(-1)!.get('company')).toBe('k1'));
    expect(await screen.findByText('Empresa: Acme SA')).toBeInTheDocument(); // el nombre sale de GET /companies/k1
    // «Nueva lista» con el filtro puesto lo guarda en filters.company
    await userEvent.click(screen.getByRole('tab', { name: 'Todos' }));
    await userEvent.type(screen.getByLabelText('Filtrar por empresa'), 'luna');
    await userEvent.click(await screen.findByRole('button', { name: 'Filtrar por la empresa Estudio Luna' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Nueva lista' }));
    const d = within(await screen.findByRole('dialog', { name: 'Nueva lista' }));
    await userEvent.type(d.getByLabelText('Nombre de la lista'), 'De Luna');
    await userEvent.click(d.getByRole('button', { name: 'Crear lista' }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0]!.body).toMatchObject({ kind: 'dynamic', filters: { company: 'k2' } });
  });

  it('exportar «lo que veo» con el filtro por empresa lo manda en la petición', async () => {
    const w = world();
    mockApi(w.routes);
    renderApp('/contacts');
    await table();
    await userEvent.type(screen.getByLabelText('Filtrar por empresa'), 'acme');
    await userEvent.click(await screen.findByRole('button', { name: 'Filtrar por la empresa Acme SA' }));
    await userEvent.click(screen.getByRole('button', { name: 'Exportar' }));
    const d = within(await screen.findByRole('dialog'));
    expect(d.getByText(/Los contactos con los filtros actuales/)).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Exportar' }));
    await waitFor(() => expect(w.exports).toHaveLength(1));
    expect(w.exports[0]!.body).toMatchObject({ company: 'k1' });
  });
});

describe('Contactos · vistas', () => {
  it('Contactos y Empresas son pestañas dentro de la misma sección; «Empresas» ya no está en el menú lateral', async () => {
    mockApi(world().routes);
    renderApp('/contacts');
    await table();
    const nav = screen.getByRole('navigation', { name: 'Secciones' });
    expect(within(nav).queryByRole('link', { name: 'Empresas' })).toBeNull();
    const tabs = within(screen.getByRole('navigation', { name: 'Vistas de contactos' }));
    expect(tabs.getByRole('link', { name: 'Contactos' })).toHaveAttribute('aria-current', 'page');
    expect(tabs.getByRole('link', { name: 'Empresas' })).toHaveAttribute('href', '/contacts/companies');
  });
});
