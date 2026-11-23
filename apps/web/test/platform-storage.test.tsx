import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanySpace, StorageGrant, StoragePlan } from '../src/features/platform/useStorage';
import { authed, ME_ROOT, mockApi, renderApp, resetWorld, type Call, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const GB = 1024 ** 3;
const AT = '2026-11-23T15:00:00.000Z';
const PLAN: StoragePlan = { id: 'pl1', name: 'Extra S', extra_bytes: 5 * GB, price_amount: '3.00', currency: 'USD', period: 'monthly', active: true, sort: 1 };
const REQ: CompanySpace = { id: 'o1', name: 'Barbería Norte', state: 'active', quota: { included_bytes: GB, extra_bytes: 0, effective_bytes: GB, next_expiry_at: null }, open_request: { id: 'r1', plan_id: 'pl1', plan_name: 'Extra S', status: 'open', note: 'Subimos el catálogo', created_at: AT } };
const OTHER: CompanySpace = { id: 'o2', name: 'Estudio Luna', state: 'active', quota: { included_bytes: GB, extra_bytes: 5 * GB, effective_bytes: 6 * GB, next_expiry_at: '2027-01-10T00:00:00.000Z' }, open_request: null };
const GRANT: StorageGrant = { id: 'g1', kind: 'grant', plan_name: 'Extra S', extra_bytes: 5 * GB, price_amount: '3.00', currency: 'USD', starts_at: AT, ends_at: '2027-01-10T00:00:00.000Z', revokes_grant_id: null, origin: 'manual', reason: null, created_at: AT, active: true, revoked: false };

interface World { open: CompanySpace[]; calls: Record<string, Call[]> }
const rec = (w: World, k: string, c: Call): void => { (w.calls[k] ??= []).push(c); };
function server(w: World): Record<string, Handler> {
  return {
    ...authed(ME_ROOT, null),
    'GET /platform/trials': () => ({ body: { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } } }),
    'GET /platform/storage-plans': () => ({ body: { items: [PLAN] } }),
    'GET /platform/storage-requests': () => ({ body: { items: w.open, truncated: false } }),
    'GET /platform/storage-companies': () => ({ body: { items: [REQ, OTHER], truncated: false } }),
    'GET /platform/companies/o2/storage-grants': () => ({ body: { items: [GRANT], quota: OTHER.quota } }),
    'POST /platform/companies/o1/storage-grants': (c) => { rec(w, 'grant', c); w.open = []; return { status: 201, body: { item: { ...GRANT, id: 'g2' }, replayed: false } }; },
    'POST /platform/companies/o2/storage-grants/g1/revoke': (c) => { rec(w, 'revoke', c); return { body: { item: GRANT } }; },
    'POST /platform/companies/o1/storage-request/dismiss': (c) => { rec(w, 'dismiss', c); w.open = []; return { body: { dismissed: true } }; },
  };
}

describe('Plataforma › Espacio', () => {
  it('lista las solicitudes y las empresas; activar un plan manda la llave de idempotencia y el plan pedido', async () => {
    const w: World = { open: [REQ], calls: {} };
    mockApi(server(w));
    renderApp('/platform/storage');
    const reqs = within(await screen.findByRole('region', { name: 'Solicitudes de espacio' }));
    expect(await reqs.findByText(/Subimos el catálogo/)).toBeInTheDocument();
    await userEvent.click(reqs.getByRole('button', { name: 'Activar plan a Barbería Norte' }));
    const d = within(await screen.findByRole('dialog', { name: /Activar espacio/ }));
    expect(d.getByRole('combobox', { name: 'Plan' })).toHaveValue('pl1'); // el plan que pidió
    await userEvent.click(d.getByRole('button', { name: 'Activar' }));
    await waitFor(() => expect(w.calls['grant']).toHaveLength(1));
    expect(w.calls['grant']![0]!.body).toEqual({ plan_id: 'pl1' });
    expect(w.calls['grant']![0]!.headers['idempotency-key']).toMatch(/^web-/);
    expect(await screen.findByText('No hay solicitudes de espacio pendientes.')).toBeInTheDocument();
  });

  it('un regalo pide el espacio y el motivo; descartar una solicitud la quita', async () => {
    const w: World = { open: [REQ], calls: {} };
    mockApi(server(w));
    renderApp('/platform/storage');
    await userEvent.click(await screen.findByRole('button', { name: 'Dar espacio a Estudio Luna' }));
    const d = within(await screen.findByRole('dialog', { name: /Activar espacio/ }));
    await userEvent.selectOptions(d.getByRole('combobox', { name: 'Plan' }), 'Regalo o ajuste (sin plan)');
    expect(d.getByRole('button', { name: 'Activar' })).toBeDisabled(); // sin espacio ni motivo
    await userEvent.type(d.getByLabelText('Espacio (GB)'), '2');
    await userEvent.type(d.getByLabelText('Motivo (obligatorio)'), 'Cortesía');
    expect(d.getByRole('button', { name: 'Activar' })).toBeEnabled();
    await userEvent.click(d.getByRole('button', { name: 'Cancelar' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Descartar la solicitud de Barbería Norte' }));
    await waitFor(() => expect(w.calls['dismiss']).toHaveLength(1));
  });

  it('ver el espacio de una empresa muestra lo vigente y permite anular con motivo', async () => {
    const w: World = { open: [], calls: {} };
    mockApi(server(w));
    renderApp('/platform/storage');
    await userEvent.click(await screen.findByRole('button', { name: 'Ver el espacio de Estudio Luna' }));
    const d = within(await screen.findByRole('dialog', { name: 'Espacio de Estudio Luna' }));
    expect(await d.findByText('Vigente')).toBeInTheDocument();
    await userEvent.click(d.getByRole('button', { name: 'Anular Extra S' }));
    expect(d.getByRole('button', { name: 'Confirmar anulación' })).toBeDisabled();
    await userEvent.type(d.getByLabelText('Motivo de la anulación'), 'Pago rechazado');
    await userEvent.click(d.getByRole('button', { name: 'Confirmar anulación' }));
    await waitFor(() => expect(w.calls['revoke']).toHaveLength(1));
    expect(w.calls['revoke']![0]!.body).toEqual({ reason: 'Pago rechazado' });
  });
});
