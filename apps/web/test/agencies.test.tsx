import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agency, AgencyList, AssignAgencyResult, Company, CompanyCreated, CompanyList, OwnershipHistoryItem } from '../src/lib/types';
import { authed, err, ME_ROOT, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const NO_TRIALS = { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } };
const agency = (over: Partial<Agency> & { id: string; name: string }): Agency => ({ state: 'active', owner_email: `${over.id}@agencia.test`, clients: 0, timezone: 'UTC', country: 'EC', created_at: new Date().toISOString(), invitation: null, ...over });
const company = (over: Partial<Company> & { id: string; name: string }): Company => ({ kind: 'client', state: 'active', plan: null, agency: null, agency_access_level: null, users: 1, owner_email: `${over.id}@empresa.test`, timezone: 'UTC', country: 'EC', invitation: null, created_at: new Date().toISOString(), trial_ends_at: null, ...over });

const UNO = agency({ id: 'uno', name: 'Agencia Uno', clients: 2 });
const DOS = agency({ id: 'dos', name: 'Agencia Dos', state: 'suspended', clients: 1 });
const TRES = agency({ id: 'tres', name: 'Agencia Tres', state: 'invited', owner_email: 'dueno@tres.test', invitation: { email: 'dueno@tres.test', expires_at: new Date(Date.now() + 4 * 86_400_000).toISOString(), expired: false } });
const A = company({ id: 'a', name: 'Barbería Norte', agency: { id: 'uno', name: 'Agencia Uno' } });
const B = company({ id: 'b', name: 'Estudio Luna', agency: { id: 'uno', name: 'Agencia Uno' }, owner_email: 'ana@luna.test' });
const C = company({ id: 'c', name: 'Café Origen' });
const D = company({ id: 'd', name: 'Taller Pérez', agency: { id: 'dos', name: 'Agencia Dos' } });
const alist = (items: Agency[]): AgencyList => ({ items, next_cursor: null });
const clist = (items: Company[]): CompanyList => ({ items, next_cursor: null });
const sent = (email = 'dueno@nueva.test') => ({ email, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), delivery: 'sent' as const });

const server = (extra: Record<string, Handler> = {}, agencies: Agency[] = [UNO, DOS, TRES], clients: Company[] = [A, B, C, D]): Record<string, Handler> => ({
  ...authed(ME_ROOT, null),
  'GET /platform/trials': () => ({ body: NO_TRIALS }),
  'GET /platform/plans': () => ({ body: { items: [], feature_catalog: [] } }),
  'GET /platform/companies': () => ({ body: clist(clients) }),
  'GET /platform/agencies': () => ({ body: alist(agencies) }),
  ...extra,
});
const changed = (over: Partial<AssignAgencyResult> = {}): { body: AssignAgencyResult } => ({ body: { id: 'c', agency: { id: 'uno', name: 'Agencia Uno' }, changed: true, notified: 1, ...over } });
const rowOf = async (name: string) => within(await screen.findByRole('list', { name: 'Agencias' })).getAllByRole('listitem').find((li) => within(li).queryByText(name))!;

describe('Agencias', () => {
  it('la consola tiene la pestaña «Agencias»; la lista muestra estado, dueño, clientes y las acciones de cada estado', async () => {
    mockApi(server());
    renderApp('/platform/agencies');
    expect(await screen.findByRole('link', { name: 'Agencias' })).toHaveAttribute('href', '/platform/agencies');
    const rows = within(await screen.findByRole('list', { name: 'Agencias' })).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const uno = rows[0]!;
    expect(within(uno).getByText('Activa')).toBeInTheDocument();
    expect(within(uno).getByText(/uno@agencia\.test/)).toBeInTheDocument();
    expect(within(uno).getByLabelText('2 clientes')).toBeInTheDocument();
    expect(within(uno).getByRole('button', { name: 'Cartera de Agencia Uno' })).toBeInTheDocument();
    expect(within(uno).getByRole('button', { name: 'Suspender a Agencia Uno' })).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Suspendida')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: 'Reactivar a Agencia Dos' })).toBeInTheDocument();
    expect(within(rows[1]!).getByLabelText('1 clientes')).toBeInTheDocument();
    const tres = rows[2]!;
    expect(within(tres).getByText('Invitación pendiente')).toBeInTheDocument();
    expect(within(tres).getByText(/dueno@tres\.test/)).toBeInTheDocument();
    expect(within(tres).getByText(/La invitación vence el \d{1,2}\/\d{1,2}/)).toBeInTheDocument();
    expect(within(tres).getByRole('button', { name: 'Reenviar la invitación de Agencia Tres' })).toBeInTheDocument();
    expect(within(tres).queryByRole('button', { name: /Suspender|Reactivar/ })).not.toBeInTheDocument(); // aún no tiene personas
  });

  it('los filtros piden estado y búsqueda a la API; sin agencias explica cómo crear la primera', async () => {
    const api = mockApi(server());
    renderApp('/platform/agencies');
    const u = userEvent.setup();
    await u.selectOptions(await screen.findByLabelText('Estado'), 'suspended');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/platform/agencies' && c.query.get('state') === 'suspended')).toBe(true));
    await u.type(screen.getByLabelText('Buscar'), 'dos');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/platform/agencies' && c.query.get('q') === 'dos')).toBe(true));
    await u.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    expect(screen.getByLabelText('Buscar')).toHaveValue('');
  });

  it('sin ninguna agencia: invita a crear la primera', async () => {
    mockApi(server({}, []));
    renderApp('/platform/agencies');
    expect(await screen.findByText(/Todavía no hay agencias/)).toBeInTheDocument();
  });

  it('«Nueva agencia»: diálogo SIN plan, crea con el cuerpo normalizado y muestra el enlace si el correo no pudo salir', async () => {
    const out: CompanyCreated = { company: { id: 'nueva', name: 'Agencia Cuatro', kind: 'agency', state: 'invited', plan: null, timezone: 'America/Guayaquil', country: 'EC' }, invitation: { ...sent(), delivery: 'unavailable', invite_url: 'https://app.ejemplo.test/accept-invite#token=abc.def' } };
    const api = mockApi(server({ 'POST /platform/agencies': () => ({ status: 201, body: out }) }));
    renderApp('/platform/agencies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Nueva agencia' }));
    const dlg = await screen.findByRole('dialog', { name: 'Nueva agencia' });
    expect(within(dlg).queryByLabelText('Plan')).not.toBeInTheDocument();
    expect(within(dlg).getByLabelText('País')).toHaveValue('EC');
    await u.type(within(dlg).getByLabelText('Nombre de la agencia'), 'Agencia Cuatro');
    await u.type(within(dlg).getByLabelText('Correo del dueño'), ' Dueno@Nueva.TEST ');
    await u.click(within(dlg).getByRole('button', { name: 'Crear e invitar' }));
    expect(await screen.findByRole('dialog', { name: 'Agencia creada' })).toBeInTheDocument();
    expect(api.last('POST /platform/agencies')?.body).toEqual({ name: 'Agencia Cuatro', owner_email: 'dueno@nueva.test', timezone: 'America/Guayaquil', country: 'EC' });
    expect(screen.getByLabelText('Enlace de invitación')).toHaveValue('https://app.ejemplo.test/accept-invite#token=abc.def');
    await waitFor(() => expect(api.count('GET /platform/agencies')).toBeGreaterThanOrEqual(2)); // la lista se refresca
  });

  it('suspender pide confirmación y explica el efecto; reactivar también; el error del servidor se muestra', async () => {
    let n = 0;
    const api = mockApi(server({
      'POST /platform/agencies/uno/suspend': () => ({ body: { id: 'uno', state: 'suspended', changed: true } }),
      'POST /platform/agencies/dos/reactivate': () => (++n === 1 ? err(500, 'INTERNAL') : { body: { id: 'dos', state: 'active', changed: true } }),
    }));
    renderApp('/platform/agencies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Suspender a Agencia Uno' }));
    const dlg = await screen.findByRole('dialog', { name: 'Suspender a Agencia Uno' });
    expect(dlg).toHaveTextContent('perderán el acceso al instante a sus 2 clientes');
    expect(dlg).toHaveTextContent('Los clientes siguen funcionando');
    await u.click(within(dlg).getByRole('button', { name: 'Suspender' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.count('POST /platform/agencies/uno/suspend')).toBe(1);

    await u.click(screen.getByRole('button', { name: 'Reactivar a Agencia Dos' }));
    const re = await screen.findByRole('dialog', { name: 'Reactivar a Agencia Dos' });
    expect(re).toHaveTextContent('recuperarán el acceso a sus 1 cliente');
    await u.click(within(re).getByRole('button', { name: 'Reactivar' }));
    expect(await within(re).findByRole('alert')).toHaveTextContent('Tuvimos un problema de nuestro lado');
    await u.click(within(re).getByRole('button', { name: 'Reactivar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('«Reenviar invitación» de una agencia usa el mismo reenvío y muestra el resultado', async () => {
    const api = mockApi(server({ 'POST /platform/companies/tres/invitation/resend': () => ({ body: sent('dueno@tres.test') }) }));
    renderApp('/platform/agencies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Reenviar la invitación de Agencia Tres' }));
    const dlg = await screen.findByRole('dialog', { name: 'Invitación de Agencia Tres' });
    expect(dlg).toHaveTextContent('Enviamos la invitación a dueno@tres.test');
    expect(api.count('POST /platform/companies/tres/invitation/resend')).toBe(1);
  });
});

describe('Cartera', () => {
  const history: OwnershipHistoryItem[] = [
    { id: 'h2', organization: { id: 'a', name: 'Barbería Norte' }, from: { id: 'dos', name: 'Agencia Dos' }, to: { id: 'uno', name: 'Agencia Uno' }, reason: 'Se muda de agencia', notify_client: false, changed_by: 'root@plataforma.test', changed_at: new Date().toISOString() },
    { id: 'h1', organization: { id: 'b', name: 'Estudio Luna' }, from: null, to: { id: 'uno', name: 'Agencia Uno' }, reason: null, notify_client: true, changed_by: 'root@plataforma.test', changed_at: new Date().toISOString() },
  ];
  const open = async (name = 'Agencia Uno') => {
    const u = userEvent.setup();
    await u.click(await within(await rowOf(name)).findByRole('button', { name: `Cartera de ${name}` }));
    return { u, dlg: await screen.findByRole('dialog', { name: `Cartera de ${name}` }) };
  };

  it('muestra solo los clientes de ESA agencia y ofrece agregar los que no están (con su administración de hoy)', async () => {
    mockApi(server({ 'GET /platform/agencies/uno/history': () => ({ body: { items: history } }) }));
    renderApp('/platform/agencies');
    const { dlg } = await open();
    const mine = within(await within(dlg).findByRole('list', { name: 'Clientes' })).getAllByRole('listitem');
    expect(mine.map((li) => li.textContent)).toEqual([expect.stringContaining('Barbería Norte'), expect.stringContaining('Estudio Luna')]);
    expect(within(dlg).getByRole('heading', { name: 'Clientes (2)' })).toBeInTheDocument();
    const opts = within(within(dlg).getByLabelText('Cliente')).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toEqual(['Elige una empresa…', 'Café Origen (administración directa)', 'Taller Pérez (hoy: Agencia Dos)']);
  });

  it('agregar: manda la agencia, el motivo y el aviso; confirma cuántas personas recibieron el correo; se puede desmarcar el aviso', async () => {
    const api = mockApi(server({ 'GET /platform/agencies/uno/history': () => ({ body: { items: history } }), 'PUT /platform/organizations/c/agency': () => changed({ notified: 1 }), 'PUT /platform/organizations/d/agency': () => changed({ id: 'd', notified: 0 }) }));
    renderApp('/platform/agencies');
    const { u, dlg } = await open();
    await u.selectOptions(await within(dlg).findByLabelText('Cliente'), 'c');
    await u.type(within(dlg).getByLabelText('Motivo (opcional)'), 'Cliente nuevo');
    await u.click(within(dlg).getByRole('button', { name: 'Agregar a la cartera' }));
    expect(await within(dlg).findByText(/Café Origen ahora pertenece a la cartera de Agencia Uno\. Avisamos a 1 persona de la empresa\./)).toBeInTheDocument();
    expect(api.last('PUT /platform/organizations/c/agency')?.body).toEqual({ agency_id: 'uno', notify_client: true, reason: 'Cliente nuevo' });

    await u.selectOptions(within(dlg).getByLabelText('Cliente'), 'd');
    await u.click(within(dlg).getByLabelText('Avisar por correo al administrador de la empresa'));
    await u.click(within(dlg).getByRole('button', { name: 'Agregar a la cartera' }));
    await waitFor(() => expect(api.count('PUT /platform/organizations/d/agency')).toBe(1));
    expect(api.last('PUT /platform/organizations/d/agency')?.body).toEqual({ agency_id: 'uno', notify_client: false }); // sin motivo no se manda el campo
  });

  it('quitar: deja al cliente en administración directa (agency_id null)', async () => {
    const api = mockApi(server({ 'GET /platform/agencies/uno/history': () => ({ body: { items: history } }), 'PUT /platform/organizations/a/agency': () => changed({ id: 'a', agency: null }) }));
    renderApp('/platform/agencies');
    const { u, dlg } = await open();
    await u.click(await within(dlg).findByRole('button', { name: 'Quitar a Barbería Norte de la cartera' }));
    expect(await within(dlg).findByText(/Barbería Norte pasó a administración directa\./)).toBeInTheDocument();
    expect(api.last('PUT /platform/organizations/a/agency')?.body).toEqual({ agency_id: null, notify_client: true });
  });

  it('una agencia suspendida no admite agregar clientes y lo explica; los errores del servidor se muestran', async () => {
    mockApi(server({ 'GET /platform/agencies/dos/history': () => ({ body: { items: [] } }) }));
    renderApp('/platform/agencies');
    const { dlg } = await open('Agencia Dos');
    expect(await within(dlg).findByText(/La agencia está suspendida/)).toBeInTheDocument();
    expect(within(dlg).getByLabelText('Cliente')).toBeDisabled();
    expect(within(dlg).getByRole('button', { name: 'Agregar a la cartera' })).toBeDisabled();
  });

  it('el error AGENCY_SUSPENDED llega con el texto del servidor', async () => {
    mockApi(server({ 'GET /platform/agencies/uno/history': () => ({ body: { items: [] } }), 'PUT /platform/organizations/c/agency': () => err(409, 'AGENCY_SUSPENDED', 'La agencia está suspendida: reactívala o elige otra') }));
    renderApp('/platform/agencies');
    const { u, dlg } = await open();
    await u.selectOptions(await within(dlg).findByLabelText('Cliente'), 'c');
    await u.click(within(dlg).getByRole('button', { name: 'Agregar a la cartera' }));
    expect(await within(dlg).findByText('La agencia está suspendida: reactívala o elige otra')).toBeInTheDocument();
  });

  it('el historial se despliega con origen, destino, motivo, quién y si se avisó al cliente', async () => {
    mockApi(server({ 'GET /platform/agencies/uno/history': () => ({ body: { items: history } }) }));
    renderApp('/platform/agencies');
    const { u, dlg } = await open();
    expect(within(dlg).queryByRole('list', { name: 'Cambios' })).not.toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Ver historial' }));
    const items = within(await within(dlg).findByRole('list', { name: 'Cambios' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Barbería Norte: Agencia Dos → Agencia Uno');
    expect(items[0]).toHaveTextContent('root@plataforma.test · Se muda de agencia · sin aviso al cliente');
    expect(items[1]).toHaveTextContent('Estudio Luna: administración directa → Agencia Uno');
    await u.click(within(dlg).getByRole('button', { name: 'Ocultar historial' }));
    expect(within(dlg).queryByRole('list', { name: 'Cambios' })).not.toBeInTheDocument();
  });
});

describe('Administración de una empresa (pestaña Empresas)', () => {
  it('cada cliente muestra quién lo administra; las agencias no llevan el botón; el filtro «Administración» llega a la API', async () => {
    const api = mockApi(server({}, [UNO, DOS, TRES], [A, C, { ...UNO, kind: 'agency', agency: null, plan: null, users: 1, owner_email: 'x@x.test', trial_ends_at: null, state: 'active' } as unknown as Company]));
    renderApp('/platform/companies');
    const rows = within(await screen.findByRole('list', { name: 'Empresas' })).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Administrada por Agencia Uno')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Administración directa')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Cambiar la administración de Barbería Norte' })).toBeInTheDocument();
    expect(within(rows[2]!).queryByRole('button', { name: /Cambiar la administración/ })).not.toBeInTheDocument();
    const u = userEvent.setup();
    const filter = screen.getByLabelText('Administración');
    expect(within(filter).getAllByRole('option').map((o) => o.textContent)).toEqual(['Todas', 'Administración directa', 'Agencia Uno', 'Agencia Dos', 'Agencia Tres']);
    await u.selectOptions(filter, 'none');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/platform/companies' && c.query.get('agency') === 'none')).toBe(true));
    await u.selectOptions(filter, 'uno');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/platform/companies' && c.query.get('agency') === 'uno')).toBe(true));
  });

  it('cambiar la administración: explica el efecto, solo ofrece agencias activas (más la actual) y guarda con motivo y aviso', async () => {
    const api = mockApi(server({ 'PUT /platform/organizations/c/agency': () => changed() }, [UNO, DOS, TRES], [C]));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Cambiar la administración de Café Origen' }));
    const dlg = await screen.findByRole('dialog', { name: 'Administración de Café Origen' });
    const select = within(dlg).getByLabelText('Administra');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Administración directa (sin agencia)', 'Agencia Uno', 'Agencia Tres']); // la suspendida no es destino
    expect(within(dlg).getByRole('button', { name: 'Guardar cambio' })).toBeDisabled();
    await u.selectOptions(select, 'uno');
    expect(dlg).toHaveTextContent('La agencia elegida recibe acceso a esta empresa. Su plan, su facturación y sus datos no cambian.');
    await u.type(within(dlg).getByLabelText('Motivo (opcional)'), 'Alta de agencia');
    await u.click(within(dlg).getByRole('button', { name: 'Guardar cambio' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.last('PUT /platform/organizations/c/agency')?.body).toEqual({ agency_id: 'uno', notify_client: true, reason: 'Alta de agencia' });
  });

  it('pasar un cliente a administración directa avisa que la agencia pierde el acceso al instante', async () => {
    const api = mockApi(server({ 'PUT /platform/organizations/a/agency': () => changed({ id: 'a', agency: null }) }, [UNO, DOS, TRES], [A]));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Cambiar la administración de Barbería Norte' }));
    const dlg = await screen.findByRole('dialog', { name: 'Administración de Barbería Norte' });
    await u.selectOptions(within(dlg).getByLabelText('Administra'), '');
    expect(dlg).toHaveTextContent('Agencia Uno pierde el acceso al instante: la empresa pasa a administración directa.');
    await u.click(within(dlg).getByLabelText('Avisar por correo al administrador de la empresa'));
    await u.click(within(dlg).getByRole('button', { name: 'Guardar cambio' }));
    await waitFor(() => expect(api.count('PUT /platform/organizations/a/agency')).toBe(1));
    expect(api.last('PUT /platform/organizations/a/agency')?.body).toEqual({ agency_id: null, notify_client: false });
  });

  it('entre agencias avisa de ambas; un error del servidor se ve en el diálogo sin cerrarlo', async () => {
    mockApi(server({ 'PUT /platform/organizations/a/agency': () => err(404, 'AGENCY_NOT_FOUND', 'La agencia no existe') }, [UNO, TRES], [A]));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Cambiar la administración de Barbería Norte' }));
    const dlg = await screen.findByRole('dialog', { name: 'Administración de Barbería Norte' });
    await u.selectOptions(within(dlg).getByLabelText('Administra'), 'tres');
    expect(dlg).toHaveTextContent('Agencia Uno pierde el acceso al instante y la agencia elegida lo recibe.');
    await u.click(within(dlg).getByRole('button', { name: 'Guardar cambio' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('La agencia no existe');
    expect(screen.getByRole('dialog', { name: 'Administración de Barbería Norte' })).toBeInTheDocument();
  });
});
