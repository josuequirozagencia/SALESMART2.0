import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Campaign, CampaignAccessInfo, CampaignRecipient, CampaignResults, CampaignsSummary } from '../src/features/campaigns/useCampaigns';
import { authed, err, ME_ADMIN, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

// v17 · 17.5 — Resultados por campaña y destinatario, CSV y la tarjeta «Campañas del periodo» de Analítica (ADR-72).

beforeEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetWorld(); });

const ADMIN: CampaignAccessInfo = { plan_enabled: true, read: true, send: true, view_all: true, manage_limits: true, manage_settings: true, cancel_others: true };
const OPTIONS = { channels: [{ id: 'c-qr', name: 'Chip QR', kind: 'qr' }], limits: { official_daily_cap: 1000, qr_min_gap_seconds: 45, official_min_gap_seconds: 5, advisor_daily_cap: null, max_audience: 5000 } };
const base: Campaign = {
  id: 'cmpR', name: 'Cupos de noviembre', status: 'running', status_reason: null, mode: 'text', channel: { id: 'c-qr', name: 'Chip QR', kind: 'qr' }, template_id: null, template_params: {}, body: 'Hola {{primer_nombre}}', body_variants: [],
  audience: { source: 'all' }, include_unknown_consent: false, scheduled_at: null, gap_seconds: 60, daily_cap: 50, created_by: { id: 'u1', name: 'Ana Pérez' }, created_at: '2026-11-16T10:00:00.000Z', updated_at: '2026-11-16T10:00:00.000Z',
  launched_at: '2026-11-16T10:05:00.000Z', finished_at: null, counts: { total: 6, by_status: {}, sent: 3, delivered: 2, read: 1, replied: 1, failed: 1, skipped: 2 }, can_edit: false, can_pause: true, can_resume: false, can_cancel: true,
};
const DONE: Campaign = { ...base, id: 'cmpD', name: 'Ya terminó', status: 'completed', can_pause: false, can_cancel: false };
const DRAFT: Campaign = { ...base, id: 'cmpB', name: 'Sin lanzar', status: 'draft', launched_at: null, counts: { total: 0, by_status: {}, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, skipped: 0 }, can_edit: true, can_pause: false, can_cancel: false };

const rec = ({ name, ...over }: Partial<CampaignRecipient> & { id: string; name: string; status: CampaignRecipient['status'] }): CampaignRecipient => ({
  contact: { id: `c-${over.id}`, name }, phone: `+5939880000${over.id}`, variant: null, skip_reason: null, error: null, queued_at: null, sent_at: '2026-11-16T10:06:00.000Z', delivered_at: null, read_at: null, replied_at: null, failed_at: null, opted_out_at: null, ...over,
});
const ALL: CampaignRecipient[] = [
  rec({ id: '01', name: 'Ana Lema', status: 'replied', replied_at: '2026-11-16T11:00:00.000Z' }),
  rec({ id: '02', name: 'Beto Vera', status: 'read' }),
  rec({ id: '03', name: 'Cata Mora', status: 'delivered' }),
  rec({ id: '04', name: 'Dani Paz', status: 'failed', error: 'WhatsApp no pudo entregar el mensaje a este número' }),
  rec({ id: '05', name: 'Eli Soto', status: 'skipped', skip_reason: 'revoked', sent_at: null, phone: '+59398800005' }),
  rec({ id: '06', name: 'Fer Ruiz', status: 'replied', replied_at: '2026-11-16T12:00:00.000Z', opted_out_at: '2026-11-16T12:00:00.000Z' }),
];
const SUMMARY = { recipients: 6, sent: 4, delivered: 3, read: 2, replied: 2, failed: 1, skipped: 1, waiting: 0, skipped_by_reason: { revoked: 1 }, opted_out: 1, delivery_rate: 0.75, reply_rate: 0.5 };

interface World { access: CampaignAccessInfo; items: Campaign[]; results: Call[]; exports: Call[]; summary: CampaignsSummary; summaryCalls: Call[] }
const world = (over: Partial<World> = {}): World => ({
  access: ADMIN, items: [base, DONE, DRAFT], results: [], exports: [], summaryCalls: [],
  summary: { period: { from: '2026-10-17T00:00:00.000Z', to: '2026-11-17T00:00:00.000Z' }, campaigns: 3, recipients: 40, sent: 30, delivered: 24, read: 15, replied: 9, failed: 2, skipped: 8, opted_out: 1, delivery_rate: 0.8, reply_rate: 0.3, scope: 'all' },
  ...over,
});

function server(w: World, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...authed(ME_ADMIN),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /contact-lists': () => ({ body: { items: [] } }),
    'GET /campaigns/access': () => ({ body: w.access }),
    'GET /campaigns/options': () => ({ body: OPTIONS }),
    'GET /campaigns': () => ({ body: { items: w.items, next_cursor: null } }),
    'GET /campaigns/settings': () => ({ body: { official_daily_cap: 1000, default_cap: 1000 } }),
    'POST /campaigns/preview': () => ({ body: { campaign_id: null, audience: { in_scope: 0, out_of_scope: 0, eligible: 0, skipped: { revoked: 0, excluded: 0, no_phone: 0, no_consent: 0, duplicate: 0 }, sample: [] }, limits: null, estimate: null, message: null, warnings: [] } }),
    'POST /campaigns/audience': () => ({ body: { items: [], total: 0, next_cursor: null } }),
    'GET /campaigns/cmpR/results': (c) => {
      w.results.push(c);
      const status = c.query.get('status');
      const cursor = c.query.get('cursor');
      const pool = status ? ALL.filter((r) => r.status === status) : ALL;
      // páginas de 4 para probar «Ver más»
      const from = cursor ? Number(cursor) : 0;
      const items = pool.slice(from, from + 4);
      const body: CampaignResults = { campaign: base, summary: SUMMARY, items, next_cursor: from + 4 < pool.length ? String(from + 4) : null };
      return { body };
    },
    'POST /campaigns/cmpR/export': (c) => { w.exports.push(c); return { text: '﻿Contacto,Teléfono\r\n', headers: { 'content-disposition': 'attachment; filename="campana-cupos-2026-11-17.csv"', 'x-export-count': '6' } }; },
    'GET /campaigns/summary': (c) => { w.summaryCalls.push(c); return { body: w.summary }; },
    ...extra,
  };
}

const downloads: string[] = [];
function stubDownloads() {
  downloads.length = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:fake');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
}

describe('resultados de una campaña', () => {
  it('muestra los totales, las tasas y cada destinatario con su estado y su detalle; quien pidió la baja y los omitidos se ven con su motivo', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    await userEvent.click(await screen.findByRole('button', { name: 'Resultados de Cupos de noviembre' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Cupos de noviembre' }));
    const list = await dlg.findByRole('list', { name: 'Tasas y omitidos' });
    expect(within(list).getByText('Entrega 75 %')).toBeInTheDocument();
    expect(within(list).getByText('Respuesta 50 %')).toBeInTheDocument();
    expect(within(list).getByText('Omitidos 1')).toBeInTheDocument();
    expect(within(list).getByText('Pidieron la baja 1')).toBeInTheDocument();
    // los totales vienen del informe, no solo de la tabla
    expect(dlg.getByText('Destinatarios').nextElementSibling).toHaveTextContent('6');
    expect(dlg.getByText('Respondieron').nextElementSibling).toHaveTextContent('2');
    const table = dlg.getByRole('table');
    expect(await within(table).findByText('Ana Lema')).toBeInTheDocument();
    const row = (name: string) => within(table).getByText(name).closest('tr')!;
    expect(within(row('Ana Lema')).getByText('Respondió')).toBeInTheDocument();
    expect(within(row('Beto Vera')).getByText('Leído')).toBeInTheDocument();
    expect(within(row('Cata Mora')).getByText('Entregado')).toBeInTheDocument();
    expect(within(row('Dani Paz')).getByText('Fallido')).toBeInTheDocument();
    expect(within(row('Dani Paz')).getByText('WhatsApp no pudo entregar el mensaje a este número')).toBeInTheDocument();
    // la primera página son 4: «Ver más» trae el resto (Eli omitido por «No contactar», Fer que pidió la baja)
    await userEvent.click(dlg.getByRole('button', { name: 'Ver más' }));
    expect(await within(table).findByText('Eli Soto')).toBeInTheDocument();
    expect(within(row('Eli Soto')).getByText('Omitido')).toBeInTheDocument();
    expect(within(row('Eli Soto')).getByText('No contactar')).toBeInTheDocument();
    expect(within(row('Fer Ruiz')).getByText(/pidió la baja/)).toBeInTheDocument();
    expect(dlg.queryByRole('button', { name: 'Ver más' })).not.toBeInTheDocument();
    expect(w.results[1]!.query.get('cursor')).toBe('4');
  });

  it('filtra por estado pidiéndolo al servidor; sin coincidencias lo dice', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    await userEvent.click(await screen.findByRole('button', { name: 'Resultados de Cupos de noviembre' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Cupos de noviembre' }));
    await dlg.findByText('Ana Lema');
    await userEvent.selectOptions(dlg.getByRole('combobox', { name: 'Estado' }), 'failed');
    await waitFor(() => expect(w.results.some((c) => c.query.get('status') === 'failed')).toBe(true));
    expect(await dlg.findByText('Dani Paz')).toBeInTheDocument();
    await waitFor(() => expect(dlg.queryByText('Ana Lema')).not.toBeInTheDocument());
    await userEvent.selectOptions(dlg.getByRole('combobox', { name: 'Estado' }), 'queued');
    expect(await dlg.findByText('Ningún destinatario con ese estado.')).toBeInTheDocument();
  });

  it('descarga el CSV con el nombre que dice el servidor; si falla lo dice y no descarga nada', async () => {
    stubDownloads();
    const w = world();
    mockApi(server(w));
    renderApp('/campaigns');
    await userEvent.click(await screen.findByRole('button', { name: 'Resultados de Cupos de noviembre' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Cupos de noviembre' }));
    await dlg.findByText('Ana Lema');
    await userEvent.click(dlg.getByRole('button', { name: 'Descargar CSV' }));
    await waitFor(() => expect(downloads).toEqual(['campana-cupos-2026-11-17.csv']));
    expect(w.exports).toHaveLength(1);
    vi.unstubAllGlobals();
    resetWorld();
    downloads.length = 0;
    mockApi(server(world(), { 'POST /campaigns/cmpR/export': () => err(404, 'NOT_FOUND', 'No existe') }));
    renderApp('/campaigns');
    await userEvent.click(await screen.findByRole('button', { name: 'Resultados de Cupos de noviembre' }));
    const dlg2 = within(await screen.findByRole('dialog', { name: 'Cupos de noviembre' }));
    await dlg2.findByText('Ana Lema');
    await userEvent.click(dlg2.getByRole('button', { name: 'Descargar CSV' }));
    expect(await dlg2.findByRole('alert')).toBeInTheDocument();
    expect(downloads).toEqual([]);
  });

  it('un borrador no tiene resultados: totales en cero, se explica y no se pide nada al servidor ni se ofrece el CSV', async () => {
    const w = world({ items: [DRAFT] });
    const api = mockApi(server(w));
    renderApp('/campaigns');
    await userEvent.click(await screen.findByRole('button', { name: 'Resultados de Sin lanzar' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Sin lanzar' }));
    expect(dlg.getByText(/es un borrador/)).toBeInTheDocument();
    expect(dlg.queryByRole('button', { name: 'Descargar CSV' })).not.toBeInTheDocument();
    expect(dlg.queryByRole('table')).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.path.endsWith('/results'))).toBe(false);
  });
});

describe('Analítica · campañas del periodo', () => {
  it('con campañas y plan muestra lo que dieron en el periodo (una sola consulta con el periodo elegido) y enlaza a Campañas', async () => {
    const w = world();
    mockApi(server(w, { 'GET /analytics/reports/sales': () => ({ body: { report: 'sales', title: 'Ventas', period: w.summary.period, timezone: 'America/Guayaquil', currency: 'USD', columns: [], rows: [], totals: null, truncated: false, access: { export: false, manage: false } } }) }));
    renderApp('/analytics');
    const card = await screen.findByRole('region', { name: 'Campañas del periodo' });
    expect(await within(card).findByText('Las de toda la empresa · las lanzadas en el periodo')).toBeInTheDocument();
    expect(within(card).getByText('Campañas').nextElementSibling).toHaveTextContent('3');
    expect(within(card).getByText('Enviados').nextElementSibling).toHaveTextContent('30');
    expect(within(card).getByText('Entrega 80 %')).toBeInTheDocument();
    expect(within(card).getByText('Respuesta 30 %')).toBeInTheDocument();
    expect(within(card).getByText('Bajas').nextElementSibling).toHaveTextContent('1');
    expect(within(card).getByRole('link', { name: 'Ver campañas' })).toHaveAttribute('href', '/campaigns');
    expect(w.summaryCalls).toHaveLength(1);
    expect(w.summaryCalls[0]!.query.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(w.summaryCalls[0]!.query.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('sin campañas en el periodo lo dice; con el alcance propio lo aclara', async () => {
    const w = world({ summary: { ...world().summary, campaigns: 0, recipients: 0, sent: 0, delivered: 0, replied: 0, scope: 'own', delivery_rate: null, reply_rate: null } });
    mockApi(server(w, { 'GET /analytics/reports/sales': () => ({ body: { report: 'sales', title: 'Ventas', period: w.summary.period, timezone: 'America/Guayaquil', currency: 'USD', columns: [], rows: [], totals: null, truncated: false, access: { export: false, manage: false } } }) }));
    renderApp('/analytics');
    const card = await screen.findByRole('region', { name: 'Campañas del periodo' });
    expect(await within(card).findByText('No se lanzó ninguna campaña en este periodo.')).toBeInTheDocument();
    expect(within(card).getByText('Solo las tuyas · las lanzadas en el periodo')).toBeInTheDocument();
  });

  it('sin permiso de ver campañas, o con un plan que no las incluye, la tarjeta no existe y no se pide nada', async () => {
    for (const access of [{ ...ADMIN, read: false }, { ...ADMIN, plan_enabled: false }]) {
      vi.unstubAllGlobals();
      resetWorld();
      const w = world({ access });
      const api = mockApi(server(w, { 'GET /analytics/reports/sales': () => ({ body: { report: 'sales', title: 'Ventas', period: w.summary.period, timezone: 'America/Guayaquil', currency: 'USD', columns: [], rows: [], totals: null, truncated: false, access: { export: false, manage: false } } }) }));
      renderApp('/analytics');
      await screen.findByRole('heading', { name: 'Analítica' });
      await waitFor(() => expect(api.calls.some((c) => c.path === '/campaigns/access')).toBe(true));
      expect(screen.queryByRole('region', { name: 'Campañas del periodo' })).not.toBeInTheDocument();
      expect(api.calls.some((c) => c.path === '/campaigns/summary')).toBe(false);
    }
  });

  it('si el resumen falla, la tarjeta lo dice sin romper el reporte', async () => {
    const w = world();
    mockApi(server(w, { 'GET /campaigns/summary': () => err(500, 'INTERNAL', 'x'), 'GET /analytics/reports/sales': () => ({ body: { report: 'sales', title: 'Ventas', period: w.summary.period, timezone: 'America/Guayaquil', currency: 'USD', columns: [{ key: 'a', label: 'A', type: 'text' }], rows: [{ a: 'fila' }], totals: null, truncated: false, access: { export: false, manage: false } } }) }));
    renderApp('/analytics');
    const card = await screen.findByRole('region', { name: 'Campañas del periodo' });
    expect(await within(card).findByText('No pudimos cargar el resumen de campañas.')).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Ventas' })).toBeInTheDocument();
  });
});
