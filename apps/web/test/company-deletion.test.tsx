// F3a (ADR-59): eliminar y recuperar una empresa desde Consola › Empresas.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Company, CompanyList, DeletionPreview } from '../src/lib/types';
import { authed, err, ME_ROOT, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const DAY = 86_400_000;
const company = (over: Partial<Company> & { id: string; name: string }): Company => ({ kind: 'client', state: 'active', plan: null, users: 2, owner_email: `${over.id}@empresa.test`, timezone: 'UTC', country: 'EC', agency: null, agency_access_level: null, invitation: null, deletion: null, created_at: new Date().toISOString(), trial_ends_at: null, ...over });
const clist = (items: Company[]): CompanyList => ({ items, next_cursor: null });

const CAFE = company({ id: 'cafe', name: 'Café Origen', plan: { id: 'pro', name: 'Pro' } });
const AGENCIA = company({ id: 'ag', name: 'Agencia Demo', kind: 'agency' });
const ELIMINADA = company({ id: 'elim', name: 'Taller Pérez', state: 'deleted', deletion: { requested_at: new Date().toISOString(), purge_after: new Date(Date.now() + 5 * DAY + 3600_000).toISOString(), reason: 'La empresa pidió cerrar su cuenta', state: 'scheduled', purge_error: null, purged_at: null } });

const PREVIEW_CAFE: DeletionPreview = { id: 'cafe', name: 'Café Origen', kind: 'client', state: 'active', plan: 'Pro', footprint: { users: 2, contacts: 120, sales: 7, ai_credits: 300, clients: 0 }, blockers: [], deletion: null, window_days: 7 };
const PREVIEW_AGENCIA: DeletionPreview = { id: 'ag', name: 'Agencia Demo', kind: 'agency', state: 'active', plan: null, footprint: { users: 1, contacts: 0, sales: 0, ai_credits: 0, clients: 2 }, blockers: [{ code: 'AGENCY_HAS_CLIENTS', clients: [{ id: 'c1', name: 'Barbería Norte' }, { id: 'c2', name: 'Estudio Luna' }] }], deletion: null, window_days: 7 };

const server = (extra: Record<string, Handler> = {}, list: Company[] = [CAFE, AGENCIA, ELIMINADA]): Record<string, Handler> => ({
  ...authed(ME_ROOT, null),
  'GET /platform/trials': () => ({ body: { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } } }),
  'GET /platform/companies': () => ({ body: clist(list) }),
  'GET /platform/plans': () => ({ body: { items: [], feature_catalog: [] } }),
  ...extra,
});

describe('Empresas eliminadas', () => {
  it('una eliminada muestra su estado, cuándo se borra y el motivo; solo ofrece «Recuperar» (nada de entrar, plan ni eliminar)', async () => {
    mockApi(server());
    renderApp('/platform/companies');
    const row = within(await screen.findByRole('list', { name: 'Empresas' })).getAllByRole('listitem')[2]!;
    expect(within(row).getByText('Taller Pérez')).toBeInTheDocument();
    expect(within(row).getByText('Eliminada')).toBeInTheDocument();
    expect(within(row).getByText(/Se borra el \d{1,2}\/\d{1,2} \(6 días\)/)).toBeInTheDocument();
    expect(within(row).getByText(/Motivo: La empresa pidió cerrar su cuenta/)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Recuperar Taller Pérez' })).toBeInTheDocument();
    for (const name of [/Entrar a/, /Cambiar el plan/, /Eliminar/]) expect(within(row).queryByRole('button', { name })).not.toBeInTheDocument();
    const live = within(screen.getByRole('list', { name: 'Empresas' })).getAllByRole('listitem')[0]!;
    expect(within(live).getByRole('button', { name: 'Eliminar Café Origen' })).toBeInTheDocument();
  });

  it('el filtro «Eliminadas» pide state=deleted a la API', async () => {
    const api = mockApi(server());
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await screen.findByText('Café Origen');
    await u.selectOptions(screen.getByLabelText('Estado'), 'deleted');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/platform/companies' && c.query.get('state') === 'deleted')).toBe(true));
  });
});

describe('Eliminar empresa', () => {
  const open = async (name: string) => {
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: `Eliminar ${name}` }));
    return { u, dlg: await screen.findByRole('dialog', { name: `Eliminar ${name}` }) };
  };

  it('resume lo que se perdería y no habilita el botón hasta tener el nombre exacto, un motivo de 10+ caracteres y la contraseña; envía los tres datos', async () => {
    const api = mockApi(server({ 'GET /platform/companies/cafe/deletion-preview': () => ({ body: PREVIEW_CAFE }), 'POST /platform/companies/cafe/delete': () => ({ body: { id: 'cafe', deletion_id: 'd1', state: 'deleted', purge_after: new Date(Date.now() + 7 * DAY).toISOString(), notified: 1 } }) }));
    renderApp('/platform/companies');
    const { u, dlg } = await open('Café Origen');
    const summary = await within(dlg).findByRole('list', { name: 'Lo que se perdería' });
    expect(within(summary).getByText(/Pro/)).toBeInTheDocument();
    expect(within(summary).getByText(/120/)).toBeInTheDocument();
    expect(within(summary).getByText(/300/)).toBeInTheDocument();
    expect(within(dlg).getByText(/todos sus datos se borran de forma definitiva/)).toBeInTheDocument();
    const go = within(dlg).getByRole('button', { name: 'Eliminar empresa' });
    expect(go).toBeDisabled();
    await u.type(within(dlg).getByLabelText(/Escribe el nombre de la empresa/), 'café origen');
    await u.type(within(dlg).getByLabelText(/Motivo/), 'Cierre pedido por el dueño');
    await u.type(within(dlg).getByLabelText(/Tu contraseña/), 'Correct-Horse-9!');
    expect(go).toBeDisabled(); // el nombre no coincide (mayúsculas y tildes cuentan)
    await u.clear(within(dlg).getByLabelText(/Escribe el nombre de la empresa/));
    await u.type(within(dlg).getByLabelText(/Escribe el nombre de la empresa/), 'Café Origen');
    expect(go).toBeEnabled();
    await u.click(go);
    expect(await within(await screen.findByRole('dialog', { name: 'Empresa eliminada' })).findByText(/quedó eliminada/)).toBeInTheDocument();
    expect(api.last('POST /platform/companies/cafe/delete')?.body).toEqual({ password: 'Correct-Horse-9!', confirm_name: 'Café Origen', reason: 'Cierre pedido por el dueño' });
    await waitFor(() => expect(api.count('GET /platform/companies')).toBeGreaterThan(1)); // se refrescó la lista
  });

  it('una contraseña incorrecta se explica, vacía el campo y no cierra el diálogo', async () => {
    mockApi(server({ 'GET /platform/companies/cafe/deletion-preview': () => ({ body: PREVIEW_CAFE }), 'POST /platform/companies/cafe/delete': () => err(403, 'PASSWORD_INVALID', 'La contraseña no es correcta') }));
    renderApp('/platform/companies');
    const { u, dlg } = await open('Café Origen');
    await within(dlg).findByRole('list', { name: 'Lo que se perdería' });
    await u.type(within(dlg).getByLabelText(/Escribe el nombre de la empresa/), 'Café Origen');
    await u.type(within(dlg).getByLabelText(/Motivo/), 'Cierre pedido por el dueño');
    await u.type(within(dlg).getByLabelText(/Tu contraseña/), 'mala-clave');
    await u.click(within(dlg).getByRole('button', { name: 'Eliminar empresa' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('La contraseña no es correcta.');
    expect(within(dlg).getByLabelText(/Tu contraseña/)).toHaveValue('');
    expect(screen.getByRole('dialog', { name: 'Eliminar Café Origen' })).toBeInTheDocument();
  });

  it('una agencia con clientes lista los clientes y no ofrece eliminar', async () => {
    mockApi(server({ 'GET /platform/companies/ag/deletion-preview': () => ({ body: PREVIEW_AGENCIA }) }));
    renderApp('/platform/companies');
    const { dlg } = await open('Agencia Demo');
    expect(await within(dlg).findByText(/todavía tiene clientes/)).toBeInTheDocument();
    expect(within(dlg).getByText('Barbería Norte')).toBeInTheDocument();
    expect(within(dlg).getByText('Estudio Luna')).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Eliminar empresa' })).not.toBeInTheDocument();
    expect(within(dlg).queryByLabelText(/Tu contraseña/)).not.toBeInTheDocument();
  });
});

describe('Recuperar empresa', () => {
  it('pide la contraseña, explica qué pasa y la envía; luego confirma', async () => {
    const api = mockApi(server({ 'POST /platform/companies/elim/recover': () => ({ body: { id: 'elim', state: 'active', notified: 1, skipped: { scheduled_messages: 0, appointment_reminders: 0, automation_waits: 0, meta_events: 0 } } }) }));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Recuperar Taller Pérez' }));
    const dlg = await screen.findByRole('dialog', { name: 'Recuperar Taller Pérez' });
    expect(within(dlg).getByText(/vuelve exactamente a como estaba/)).toBeInTheDocument();
    const go = within(dlg).getByRole('button', { name: 'Recuperar empresa' });
    expect(go).toBeDisabled();
    await u.type(within(dlg).getByLabelText(/Tu contraseña/), 'Correct-Horse-9!');
    await u.click(go);
    expect(await screen.findByRole('dialog', { name: 'Empresa recuperada' })).toBeInTheDocument();
    expect(api.last('POST /platform/companies/elim/recover')?.body).toEqual({ password: 'Correct-Horse-9!' });
  });

  it('si el plazo terminó, muestra el motivo del servidor', async () => {
    mockApi(server({ 'POST /platform/companies/elim/recover': () => err(409, 'RECOVERY_WINDOW_CLOSED', 'El plazo para recuperar esta empresa terminó') }));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Recuperar Taller Pérez' }));
    const dlg = await screen.findByRole('dialog', { name: 'Recuperar Taller Pérez' });
    await u.type(within(dlg).getByLabelText(/Tu contraseña/), 'Correct-Horse-9!');
    await u.click(within(dlg).getByRole('button', { name: 'Recuperar empresa' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('El plazo para recuperar esta empresa terminó');
  });
});

describe('Borrado definitivo en la lista (F3c)', () => {
  const del = (state: 'purging' | 'purge_failed' | 'purged', extra: Record<string, unknown> = {}) =>
    company({ id: 'x', name: 'Taller Vega', state: state === 'purged' ? 'purged' : 'deleted', deletion: { requested_at: new Date(Date.now() - 9 * DAY).toISOString(), purge_after: new Date(Date.now() - DAY).toISOString(), reason: 'Cierre', state, purge_error: null, purged_at: null, ...extra } });

  it('mientras se borra de forma definitiva no ofrece Recuperar ni Descargar todo', async () => {
    mockApi(server({}, [del('purging')]));
    renderApp('/platform/companies');
    const row = within(await screen.findByRole('list', { name: 'Empresas' })).getAllByRole('listitem')[0]!;
    expect(within(row).getByText('Eliminada')).toBeInTheDocument();
    expect(within(row).getByText(/Borrando de forma definitiva/)).toBeInTheDocument();
    for (const name of [/Recuperar/, /Descargar todo/, /Eliminar/, /Entrar a/]) expect(within(row).queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('si el borrado falló lo dice con su código y avisa que se reintenta solo; sigue sin ofrecer Recuperar', async () => {
    mockApi(server({}, [del('purge_failed', { purge_error: 'STORAGE_UNAVAILABLE' })]));
    renderApp('/platform/companies');
    const row = within(await screen.findByRole('list', { name: 'Empresas' })).getAllByRole('listitem')[0]!;
    expect(within(row).getByText(/El borrado definitivo falló \(STORAGE_UNAVAILABLE\); se reintenta solo/)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Recuperar/ })).not.toBeInTheDocument();
  });

  it('una empresa ya borrada se ve como «Borrada definitivamente» con su fecha y sin ninguna acción', async () => {
    mockApi(server({}, [del('purged', { purged_at: new Date().toISOString() })]));
    renderApp('/platform/companies');
    const row = within(await screen.findByRole('list', { name: 'Empresas' })).getAllByRole('listitem')[0]!;
    expect(within(row).getByText('Borrada definitivamente')).toBeInTheDocument();
    expect(within(row).getByText(/Borrada de forma definitiva el \d{1,2}\/\d{1,2}/)).toBeInTheDocument();
    expect(within(row).queryAllByRole('button')).toHaveLength(0);
  });
});
