import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportRecord, Report, Summary } from '../src/features/analytics/useAnalytics';
import { authed, EMPTY_SUMMARY, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); stubDownloads(); });

const downloads: string[] = [];
function stubDownloads() {
  downloads.length = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:fake');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
}

const SUMMARY: Summary = {
  ...EMPTY_SUMMARY,
  leads: 12, appointments: { total: 5, scheduled: 2, completed: 2, cancelled: 1 },
  sales: { count: 3, cancelled: 1, revenue: '350.00', paid: '90.00', balance: '260.00' },
  funnel: [
    { pipeline_id: 'pl1', pipeline: 'Ventas', stage_id: 's1', stage: 'Nuevo', kind: 'open', count: 4, amount: '200.00' },
    { pipeline_id: 'pl1', pipeline: 'Ventas', stage_id: 's2', stage: 'Ganada', kind: 'won', count: 2, amount: '350.00' },
  ],
  response: { count: 3, avg_seconds: 280, median_seconds: 180 },
  series: [{ day: '2026-10-20', leads: 3, sales: 2, revenue: '300.00' }, { day: '2026-10-21', leads: 1, sales: 0, revenue: '0.00' }],
  access: { export: true, manage: true },
};
const REPORT: Report = {
  report: 'sales', title: 'Ventas', period: SUMMARY.period, timezone: 'America/Guayaquil', currency: 'USD', truncated: false, access: { export: true, manage: true },
  columns: [{ key: 'contact', label: 'Contacto', type: 'text' }, { key: 'amount', label: 'Total', type: 'money' }, { key: 'seller', label: 'Vendedor', type: 'person' }],
  rows: [{ contact: 'Ana Torres', amount: '150.00', seller: { id: 'u2', name: 'Luis Navas' } }, { contact: 'Mario Paz', amount: '200.00', seller: { id: 'u3', name: 'Carolina Vera' } }],
  totals: { amount: '350.00' },
};

const REC = (over: Partial<ExportRecord> = {}): ExportRecord => ({ id: 'x1', by: { id: 'u2', name: 'Luis Navas' }, report: 'sales', from: '2026-09-24T05:00:00.000Z', to: '2026-10-24T05:00:00.000Z', rows: 7, scope: 'own', at: '2026-10-24T15:30:00.000Z', ...over });
interface World { summaryCalls: Call[]; reportCalls: Call[]; exports: Call[]; summary: Summary; report: Report; log: ExportRecord[]; advisorExport: boolean; puts: unknown[] }
const world = (over: Partial<World> = {}): World => ({ summaryCalls: [], reportCalls: [], exports: [], summary: SUMMARY, report: REPORT, log: [], advisorExport: true, puts: [], ...over });
function server(w: World, me = ME_ADMIN): Record<string, Handler> {
  return {
    ...authed(me),
    'GET /analytics/summary': (c) => { w.summaryCalls.push(c); return { body: w.summary }; },
    'GET /analytics/reports/sales': (c) => { w.reportCalls.push(c); return { body: w.report }; },
    'GET /analytics/reports/funnel': (c) => { w.reportCalls.push(c); return { body: { ...w.report, report: 'funnel', title: 'Embudo', rows: [], totals: null } }; },
    'GET /analytics/exports': () => ({ body: { items: w.log, next_cursor: null } }),
    'GET /analytics/settings': () => ({ body: { advisor_export: w.advisorExport } }),
    'PUT /analytics/settings': (c) => { w.puts.push(c.body); w.advisorExport = (c.body as { advisor_export: boolean }).advisor_export; return { body: { advisor_export: w.advisorExport } }; },
    'POST /analytics/export': (c) => { w.exports.push(c); return { text: '﻿Contacto\r\n', headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="sales-2026-10-24.csv"' } }; },
  };
}

describe('Tablero de Inicio', () => {
  it('muestra las cifras del periodo, el embudo y el aviso de alcance', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/');
    expect(await screen.findByText('De toda la empresa · hora de America/Guayaquil')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument(); // contactos nuevos
    const card = (label: string) => screen.getByText(label).parentElement!;
    expect(within(card('Ingresos')).getByText(/350,00/)).toBeInTheDocument();
    expect(within(card('Ingresos')).getByText(/Cobrado .*90,00/)).toBeInTheDocument();
    expect(within(card('Saldo por cobrar')).getByText(/260,00/)).toBeInTheDocument();
    expect(screen.getByText(/1 anulada\(s\)/)).toBeInTheDocument();
    const funnel = screen.getByRole('list', { name: 'Embudo Ventas' });
    expect(within(funnel).getByText('Nuevo')).toBeInTheDocument();
    expect(within(funnel).getByText('Ganada ✓')).toBeInTheDocument();
    expect(screen.getByText(/Mediana/)).toBeInTheDocument();
  });

  it('pide los últimos 30 días y, al elegir otro periodo, vuelve a consultar con otro rango', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/');
    await screen.findByText('De toda la empresa · hora de America/Guayaquil');
    const days = (c: Call) => Math.round((Date.parse(c.query.get('to')!) - Date.parse(c.query.get('from')!)) / 86_400_000);
    expect(days(w.summaryCalls[0]!)).toBe(30);
    await userEvent.selectOptions(screen.getByLabelText('Periodo'), '7');
    await waitFor(() => expect(w.summaryCalls.some((c) => days(c) === 7)).toBe(true));
  });

  it('a un asesor se le avisa de que solo ve lo suyo', async () => {
    const w = world({ summary: { ...SUMMARY, scope: 'own' } });
    mockApi(server(w, ME_ADVISOR));
    renderApp('/');
    expect(await screen.findByText('Solo lo tuyo · hora de America/Guayaquil')).toBeInTheDocument();
  });

  it('sin ventas ni pipelines lo dice en vez de dejar un hueco', async () => {
    mockApi(server(world({ summary: EMPTY_SUMMARY })));
    renderApp('/');
    expect(await screen.findByText('Sin ventas en el periodo.')).toBeInTheDocument();
    expect(screen.getByText(/Todavía no hay pipelines/)).toBeInTheDocument();
    expect(screen.getByText('Sin respuestas en el periodo')).toBeInTheDocument();
  });

  it('si el servidor falla muestra el error y no cifras', async () => {
    mockApi({ ...server(world()), 'GET /analytics/summary': () => err(500, 'INTERNAL_ERROR', 'Error interno') });
    renderApp('/');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/De toda la empresa/)).not.toBeInTheDocument();
  });
});

describe('Analítica', () => {
  it('muestra la tabla del reporte con dinero, personas y totales', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/analytics');
    const table = await screen.findByRole('table', { name: 'Ventas' });
    expect(within(table).getByText('Ana Torres')).toBeInTheDocument();
    expect(within(table).getByText('Luis Navas')).toBeInTheDocument();
    expect(within(table).getByText(/150,00/)).toBeInTheDocument();
    const foot = within(table.querySelector('tfoot')!);
    expect(foot.getByText('Total')).toBeInTheDocument();
    expect(foot.getByText(/350,00/)).toBeInTheDocument();
  });

  it('cambiar de pestaña pide ese reporte', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/analytics');
    await screen.findByRole('table', { name: 'Ventas' });
    await userEvent.click(screen.getByRole('tab', { name: 'Embudo' }));
    expect(await screen.findByText('No hay datos en este periodo.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Embudo' })).toHaveAttribute('aria-selected', 'true');
  });

  it('descarga el CSV del reporte y periodo elegidos', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/analytics');
    await screen.findByRole('table', { name: 'Ventas' });
    await userEvent.click(screen.getByRole('button', { name: 'Descargar CSV' }));
    await waitFor(() => expect(downloads).toEqual(['sales-2026-10-24.csv']));
    expect(w.exports[0]!.body).toMatchObject({ report: 'sales' });
    expect(Object.keys(w.exports[0]!.body as object).sort()).toEqual(['from', 'report', 'to']);
  });

  it('sin permiso de exportar no aparece el botón', async () => {
    const w = world({ report: { ...REPORT, access: { export: false, manage: false } } });
    mockApi(server(w, ME_ADVISOR));
    renderApp('/analytics');
    await screen.findByRole('table', { name: 'Ventas' });
    expect(screen.queryByRole('button', { name: 'Descargar CSV' })).not.toBeInTheDocument();
  });

  it('avisa cuando el reporte está truncado', async () => {
    mockApi(server(world({ report: { ...REPORT, truncated: true } })));
    renderApp('/analytics');
    expect(await screen.findByText(/más filas de las que se muestran/)).toBeInTheDocument();
  });

  it('si la descarga falla lo dice', async () => {
    mockApi({ ...server(world()), 'POST /analytics/export': () => err(403, 'FORBIDDEN', 'Sin permiso') });
    renderApp('/analytics');
    await screen.findByRole('table', { name: 'Ventas' });
    await userEvent.click(screen.getByRole('button', { name: 'Descargar CSV' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(downloads).toEqual([]);
  });
});

describe('Descargas', () => {
  it('el administrador ve la pestaña con el registro (quién, qué, cuándo) y el interruptor activado', async () => {
    const w = world({ log: [REC(), REC({ id: 'x2', by: { id: 'u1', name: 'Ana Pérez' }, report: 'advisors', scope: 'all', rows: 3 })] });
    mockApi(server(w));
    renderApp('/analytics');
    await screen.findByRole('table', { name: 'Ventas' });
    await userEvent.click(screen.getByRole('tab', { name: 'Descargas' }));
    const table = await screen.findByRole('table', { name: 'Descargas de reportes' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // encabezado + 2
    expect(within(rows[1]!).getByText('Luis Navas')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Ventas')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Solo lo suyo')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Ana Pérez')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Toda la empresa')).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: 'Permitir que los asesores descarguen reportes' })).toBeChecked();
  });

  it('sin descargas lo dice', async () => {
    mockApi(server(world()));
    renderApp('/analytics');
    await screen.findByRole('table', { name: 'Ventas' });
    await userEvent.click(screen.getByRole('tab', { name: 'Descargas' }));
    expect(await screen.findByText('Todavía nadie ha descargado un reporte.')).toBeInTheDocument();
  });

  it('apagar el interruptor manda el cambio al servidor y avisa que los asesores no podrán descargar', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/analytics');
    await screen.findByRole('table', { name: 'Ventas' });
    await userEvent.click(screen.getByRole('tab', { name: 'Descargas' }));
    const sw = await screen.findByRole('switch', { name: 'Permitir que los asesores descarguen reportes' });
    await userEvent.click(sw);
    await waitFor(() => expect(w.puts).toEqual([{ advisor_export: false }]));
    expect(await screen.findByText(/Desactivado: los asesores siguen viendo su tablero/)).toBeInTheDocument();
    expect(sw).not.toBeChecked();
  });

  it('el asesor no ve la pestaña ni pide el registro o el interruptor', async () => {
    const w = world({ report: { ...REPORT, access: { export: true, manage: false } } });
    const routes = server(w, ME_ADVISOR);
    const m = mockApi(routes);
    renderApp('/analytics');
    await screen.findByRole('table', { name: 'Ventas' });
    expect(screen.queryByRole('tab', { name: 'Descargas' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Descargar CSV' })).toBeInTheDocument();
    expect(m.count('GET /analytics/exports')).toBe(0);
    expect(m.count('GET /analytics/settings')).toBe(0);
  });

  it('con la descarga desactivada para el asesor, no aparece el botón', async () => {
    mockApi(server(world({ report: { ...REPORT, access: { export: false, manage: false } } }), ME_ADVISOR));
    renderApp('/analytics');
    await screen.findByRole('table', { name: 'Ventas' });
    expect(screen.queryByRole('button', { name: 'Descargar CSV' })).not.toBeInTheDocument();
  });

  it('si el servidor niega la descarga (403 EXPORT_DISABLED) muestra el motivo', async () => {
    mockApi({ ...server(world()), 'POST /analytics/export': () => err(403, 'EXPORT_DISABLED', 'La descarga de reportes no está habilitada para tu usuario. Pídele al administrador que la active') });
    renderApp('/analytics');
    await screen.findByRole('table', { name: 'Ventas' });
    await userEvent.click(screen.getByRole('button', { name: 'Descargar CSV' }));
    expect(await screen.findByText(/no está habilitada para tu usuario/)).toBeInTheDocument();
    expect(downloads).toEqual([]);
  });
});
