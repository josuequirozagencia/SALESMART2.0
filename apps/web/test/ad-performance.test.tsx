import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdPerformance, AdPerformanceRow, Contact, ContactAttribution } from '../src/lib/types';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); window.localStorage.clear(); });

const row = (over: Partial<AdPerformanceRow> = {}): AdPerformanceRow => ({ adName: 'Corte promo', adsetName: 'Conjunto 1', campaignName: 'Octubre', channel: 'facebook', leads: 4, sales: 2, convRate: 50, isTopAd: false, ...over });
const perf = (rows: AdPerformanceRow[]): AdPerformance => ({ rows, period: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }, touchModel: 'last' });

function server(w: { data: AdPerformance | 'forbidden'; calls: URLSearchParams[]; manage?: boolean }) {
  const routes: Record<string, Handler> = {
    ...authed(ME_ADMIN),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: w.manage ?? true } } }),
    'GET /attribution/ad-performance': (call) => {
      w.calls.push(call.query);
      return w.data === 'forbidden' ? err(403, 'FORBIDDEN', 'No tienes permiso') : { body: w.data };
    },
  };
  return routes;
}

describe('Rendimiento de anuncios (M3.3 §12)', () => {
  it('muestra la tabla con anuncio, conjunto, campaña, canal, leads, ventas y conversión, y la estrella solo en el anuncio con más ventas', async () => {
    mockApi(server({ data: perf([row({ isTopAd: true }), row({ adName: 'Tinte', adsetName: 'Conjunto 2', campaignName: 'Noviembre', channel: 'instagram', leads: 3, sales: 1, convRate: 33.3 })]), calls: [] }));
    renderApp('/attribution');
    const table = await screen.findByRole('table', { name: 'Rendimiento de anuncios' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('Corte promo')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('img', { name: 'Anuncio con más ventas en el periodo' })).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Facebook')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('50 %')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Instagram')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/33,3/)).toBeInTheDocument();
    expect(within(rows[2]!).queryByRole('img', { name: 'Anuncio con más ventas en el periodo' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Anuncio con más ventas en el periodo' })).toHaveLength(2); // tabla + tarjetas (en pantalla angosta solo se ven las tarjetas)
  });

  it('sin ventas no hay estrella', async () => {
    mockApi(server({ data: perf([row({ sales: 0, convRate: 0 })]), calls: [] }));
    renderApp('/attribution');
    await screen.findByRole('table', { name: 'Rendimiento de anuncios' });
    expect(screen.queryByRole('img', { name: 'Anuncio con más ventas en el periodo' })).not.toBeInTheDocument();
  });

  it('en el móvil se ofrecen tarjetas con anuncio, leads, ventas y conversión', async () => {
    mockApi(server({ data: perf([row({ isTopAd: true })]), calls: [] }));
    renderApp('/attribution');
    const cards = await screen.findByRole('list', { name: 'Rendimiento de anuncios' });
    const card = within(within(cards).getAllByRole('listitem')[0]!);
    expect(card.getByText('Corte promo')).toBeInTheDocument();
    expect(card.getByText('Leads')).toBeInTheDocument();
    expect(card.getByText('Ventas')).toBeInTheDocument();
    expect(card.getByText('Conv.%')).toBeInTheDocument();
  });

  it('los filtros de periodo (7/30/90 y rango libre), canal y agrupación llegan al servidor', async () => {
    const w = { data: perf([row()]), calls: [] as URLSearchParams[] };
    mockApi(server(w));
    renderApp('/attribution');
    await screen.findByRole('table', { name: 'Rendimiento de anuncios' });
    const first = w.calls.at(-1)!;
    expect(first.get('touchModel')).toBe('last');
    expect(first.get('channel')).toBeNull();
    const days = (q: URLSearchParams): number => Math.round((new Date(q.get('to')!).getTime() - new Date(q.get('from')!).getTime()) / 86_400_000);
    expect(days(first)).toBe(30);
    await userEvent.selectOptions(screen.getByLabelText('Periodo'), 'Últimos 7 días');
    await waitFor(() => expect(days(w.calls.at(-1)!)).toBe(7));
    await userEvent.selectOptions(screen.getByLabelText('Periodo'), 'Últimos 90 días');
    await waitFor(() => expect(days(w.calls.at(-1)!)).toBe(90));
    await userEvent.selectOptions(screen.getByLabelText('Canal'), 'Instagram');
    await waitFor(() => expect(w.calls.at(-1)!.get('channel')).toBe('instagram'));
    await userEvent.selectOptions(screen.getByLabelText('Agrupar por'), 'Anuncio que lo trajo');
    await waitFor(() => expect(w.calls.at(-1)!.get('touchModel')).toBe('first'));
    await userEvent.selectOptions(screen.getByLabelText('Periodo'), 'Rango libre…');
    expect(screen.getByLabelText('Desde')).toBeInTheDocument();
    expect(screen.getByLabelText('Hasta')).toBeInTheDocument();
  });

  it('sin datos: mensaje vacío con el enlace a «Configuración › Atribución de Meta»', async () => {
    mockApi(server({ data: perf([]), calls: [] }));
    renderApp('/attribution');
    expect(await screen.findByText(/Todavía no hay datos de anuncios/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configuración › Atribución de Meta' })).toHaveAttribute('href', '/settings/attribution');
  });

  it('sin permiso (403) lo explica', async () => {
    mockApi(server({ data: 'forbidden', calls: [] }));
    renderApp('/attribution');
    expect(await screen.findByText(/No tienes permiso para ver el rendimiento de anuncios/)).toBeInTheDocument();
  });

  it('el menú lateral ofrece la sección solo a quien administra', async () => {
    mockApi(server({ data: perf([row()]), calls: [], manage: true }));
    renderApp('/attribution');
    await screen.findByRole('table', { name: 'Rendimiento de anuncios' });
    expect(screen.getAllByRole('link', { name: 'Rendimiento de anuncios' }).length).toBeGreaterThan(0);
  });

  it('un asesor (sin administrar) no ve la sección en el menú', async () => {
    mockApi(server({ data: perf([row()]), calls: [], manage: false }));
    renderApp('/');
    await screen.findAllByRole('link', { name: 'Analítica' });
    expect(screen.queryByRole('link', { name: 'Rendimiento de anuncios' })).not.toBeInTheDocument();
  });
});

const attr = (over: Partial<ContactAttribution> = {}): ContactAttribution => ({ ctwa_cl_id: 'AbC123', channel: 'instagram', first_touch: null, last_touch: { at: '2026-10-12T15:00:00.000Z', source: 'meta_ctwa', campaign: 'Barbería', adset: 'Conjunto B', ad: 'Anuncio 2' }, capi: null, ...over });
const contact = (over: Partial<Contact> = {}): Contact => ({
  id: 'c1', name: 'Ana Torres', email: null, phones: [{ e164: '+593984217730', primary: true }], owner: null, source: 'meta_ctwa', channel: 'instagram', consent: 'unknown', consent_updated_at: null,
  custom_fields: {}, tags: [], companies: [], attribution: attr(), created_at: '2026-10-10T15:00:00.000Z', updated_at: '2026-10-10T15:00:00.000Z', ...over,
});
const contactsServer = (c: Contact): Record<string, Handler> => ({
  ...authed(ME_ADMIN),
  'GET /contacts': () => ({ body: { items: [c], next_cursor: null, total: 1, access: { view_all: true, write: true, delete: true, import: true, export: true } } }),
  'GET /contacts/owners': () => ({ body: { items: [] } }),
});

describe('Canal del lead (M3.3 §11)', () => {
  it('la sección «Origen del lead» muestra la insignia del canal', async () => {
    mockApi(contactsServer(contact()));
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' }));
    const d = within(await screen.findByRole('dialog', { name: 'Contacto' }));
    const o = within(d.getByRole('region', { name: 'Origen del lead' }));
    expect(within(o.getByLabelText('Canal del lead')).getByText('Instagram')).toBeInTheDocument();
  });

  it.each([
    ['facebook', 'Facebook'],
    ['whatsapp', 'WhatsApp'],
    ['manual', 'Manual'],
    ['other', 'Otro canal'],
  ] as const)('la insignia del canal %s dice «%s»', async (channel, label) => {
    mockApi(contactsServer(contact({ channel, attribution: attr({ channel }) })));
    renderApp('/contacts');
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir el contacto Ana Torres' }));
    const o = within((await screen.findByRole('dialog', { name: 'Contacto' })).querySelector('[aria-label="Canal del lead"]') as HTMLElement);
    expect(o.getByText(label)).toBeInTheDocument();
  });

  it('la columna «Canal» es opcional: se agrega desde «Columnas» y muestra la insignia', async () => {
    mockApi(contactsServer(contact({ attribution: null, channel: 'whatsapp' })));
    renderApp('/contacts');
    const table = await screen.findByRole('table', { name: 'Contactos' });
    expect(within(table).queryByRole('columnheader', { name: 'Canal' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Columnas/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Canal' }));
    expect(within(await screen.findByRole('table', { name: 'Contactos' })).getByRole('columnheader', { name: 'Canal' })).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Contactos' })).getByText('WhatsApp')).toBeInTheDocument();
  });
});
