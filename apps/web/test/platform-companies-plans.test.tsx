import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Company, CompanyList, Plan, PlanList } from '../src/lib/types';
import { authed, err, ME_ROOT, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const CATALOG = [{ key: 'kanban', label: 'Kanban' }, { key: 'agenda', label: 'Agenda' }, { key: 'campaigns', label: 'Campañas' }, { key: 'ai_agents', label: 'Agentes IA' }];
const plan = (over: Partial<Plan> & { id: string; name: string }): Plan => ({ description: null, max_users: null, max_connections: null, max_queues: null, features: {}, archived: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), companies: 0, ...over });
const company = (over: Partial<Company> & { id: string; name: string }): Company => ({ kind: 'client', state: 'trial', plan: null, users: 1, owner_email: `${over.id}@empresa.test`, timezone: 'UTC', country: 'EC', agency: null, agency_access_level: null, invitation: null, created_at: new Date().toISOString(), trial_ends_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), ...over });

const PRO = plan({ id: 'pro', name: 'Pro', description: 'Para equipos', max_users: 10, max_connections: 5, features: { kanban: true, agenda: true, ai_agents: true }, companies: 2 });
const BASICO = plan({ id: 'basico', name: 'Básico', max_users: 3, features: { kanban: true } });
const VIEJO = plan({ id: 'viejo', name: 'Viejo', archived: true });
const planList = (items: Plan[]): PlanList => ({ items, feature_catalog: CATALOG });
const clist = (items: Company[], next: string | null = null): CompanyList => ({ items, next_cursor: next });

const LUNA = company({ id: 'luna', name: 'Estudio Luna', state: 'trial_expired', owner_email: 'ana@luna.test', users: 3 });
const BARBERIA = company({ id: 'barb', name: 'Barbería Norte', state: 'trial', owner_email: 'luis@barberia.test' });
const CAFE = company({ id: 'cafe', name: 'Café Origen', state: 'active', plan: { id: 'pro', name: 'Pro' }, trial_ends_at: null, users: 5 });
const AGENCIA = company({ id: 'ag', name: 'Agencia Demo', kind: 'agency', state: 'active', trial_ends_at: null });
const SUSP = company({ id: 'sus', name: 'Taller Pérez', state: 'suspended', trial_ends_at: null });

interface Server { companies?: Handler; plans?: Handler; extra?: Record<string, Handler> }
const server = (s: Server = {}): Record<string, Handler> => ({
  ...authed(ME_ROOT, null),
  'GET /platform/trials': () => ({ body: { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } } }),
  'GET /platform/companies': s.companies ?? (() => ({ body: clist([LUNA, BARBERIA, CAFE, AGENCIA, SUSP]) })),
  'GET /platform/plans': s.plans ?? ((c) => ({ body: planList(c.query.get('include_archived') === 'true' ? [PRO, BASICO, VIEJO] : [PRO, BASICO]) })),
  ...s.extra,
});

describe('Empresas', () => {
  it('lista cada empresa con su estado, plan, usuarios, responsable y fin de prueba; la agencia lleva su etiqueta', async () => {
    mockApi(server());
    renderApp('/platform/companies');
    const rows = within(await screen.findByRole('list', { name: 'Empresas' })).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByText('Estudio Luna')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Prueba vencida')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/ana@luna\.test/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Venció el \d{1,2}\/\d{1,2}/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Sin plan')).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText('3 usuarios')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('En prueba')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Vence el \d{1,2}\/\d{1,2}/)).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Activa')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Pro')).toBeInTheDocument();
    expect(within(rows[2]!).queryByText(/Vence el/)).not.toBeInTheDocument();
    expect(within(rows[3]!).getByText('Agencia')).toBeInTheDocument();
    expect(within(rows[4]!).getByText('Suspendida')).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('button', { name: 'Cambiar el plan de Café Origen' })).toHaveTextContent('Cambiar plan');
    expect(within(rows[0]!).getByRole('button', { name: 'Cambiar el plan de Estudio Luna' })).toHaveTextContent('Asignar plan');
  });

  it('los filtros piden a la API tipo, estado y plan («Sin plan» = none); «Limpiar filtros» los quita', async () => {
    const api = mockApi(server());
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await screen.findByText('Estudio Luna');
    await u.selectOptions(screen.getByLabelText('Tipo'), 'agency');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/platform/companies' && c.query.get('kind') === 'agency')).toBe(true));
    await u.selectOptions(screen.getByLabelText('Estado'), 'trial_expired');
    await waitFor(() => expect(api.calls.some((c) => c.query.get('state') === 'trial_expired' && c.query.get('kind') === 'agency')).toBe(true));
    await u.selectOptions(screen.getByLabelText('Plan'), 'none');
    await waitFor(() => expect(api.calls.some((c) => c.query.get('plan') === 'none')).toBe(true));
    await u.selectOptions(screen.getByLabelText('Plan'), 'pro'); // las opciones salen del catálogo de planes
    await waitFor(() => expect(api.calls.some((c) => c.query.get('plan') === 'pro')).toBe(true));
    await u.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    await waitFor(() => expect(api.calls.at(-1)?.query.has('kind')).toBe(false));
    expect(screen.getByLabelText('Tipo')).toHaveValue('');
  });

  it('la búsqueda espera a que termines de escribir (una sola consulta) y se envía recortada', async () => {
    const api = mockApi(server());
    renderApp('/platform/companies');
    const u = userEvent.setup();
    await screen.findByText('Estudio Luna');
    const before = api.count('GET /platform/companies');
    await u.type(screen.getByLabelText('Buscar'), '  luna ');
    await waitFor(() => expect(api.calls.some((c) => c.query.get('q') === 'luna')).toBe(true));
    expect(api.count('GET /platform/companies') - before).toBe(1);
  });

  it('paginación por cursor, vacío con y sin filtros y error con reintento', async () => {
    let fail = true;
    let empty = false;
    const api = mockApi(server({ companies: (c) => (fail ? err(500, 'INTERNAL') : empty ? { body: clist([]) } : c.query.get('cursor') ? { body: clist([SUSP]) } : { body: clist([LUNA], 'c2') }) }));
    renderApp('/platform/companies');
    const u = userEvent.setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('Tuvimos un problema de nuestro lado');
    fail = false;
    await u.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByText('Estudio Luna');
    await u.click(screen.getByRole('button', { name: 'Cargar más' }));
    expect(await screen.findByText('Taller Pérez')).toBeInTheDocument();
    expect(api.calls.some((c) => c.query.get('cursor') === 'c2')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
    empty = true;
    await u.selectOptions(screen.getByLabelText('Tipo'), 'client');
    expect(await screen.findByText('Ninguna empresa coincide con los filtros.')).toBeInTheDocument();
  });

  it('sin empresas: mensaje claro', async () => {
    mockApi(server({ companies: () => ({ body: clist([]) }) }));
    renderApp('/platform/companies');
    expect(await screen.findByText('Todavía no hay empresas.')).toBeInTheDocument();
  });
});

describe('Asignar un plan a una empresa', () => {
  const open = async (name: string) => {
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: `Cambiar el plan de ${name}` }));
    return { u, dlg: await screen.findByRole('dialog', { name: `Plan de ${name}` }) };
  };

  it('ofrece solo planes NO archivados, explica que sale de la prueba y envía el plan elegido', async () => {
    const api = mockApi(server({ extra: { 'PUT /platform/companies/luna/plan': () => ({ body: { id: 'luna', state: 'active', plan: { id: 'pro', name: 'Pro' } } }) } }));
    renderApp('/platform/companies');
    const { u, dlg } = await open('Estudio Luna');
    const options = within(dlg).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Sin plan', 'Pro', 'Básico']); // «Viejo» (archivado) no aparece
    const confirm = within(dlg).getByRole('button', { name: 'Quitar plan' });
    expect(confirm).toBeDisabled(); // sin cambios no se envía nada
    await u.selectOptions(within(dlg).getByLabelText('Plan'), 'pro');
    expect(within(dlg).getByText(/dejará de estar en prueba/)).toBeInTheDocument();
    expect(within(dlg).getByText(/si estaba vencida y en pausa, se reabre/)).toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Asignar plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.last('PUT /platform/companies/luna/plan')?.body).toEqual({ plan_id: 'pro' });
    await waitFor(() => expect(api.count('GET /platform/companies')).toBeGreaterThan(1)); // se refrescó la lista
  });

  it('quitar el plan: explica que vuelve a depender de la prueba y envía plan_id null', async () => {
    const api = mockApi(server({ extra: { 'PUT /platform/companies/cafe/plan': () => ({ body: {} }) } }));
    renderApp('/platform/companies');
    const { u, dlg } = await open('Café Origen');
    expect(within(dlg).getByLabelText('Plan')).toHaveValue('pro');
    await u.selectOptions(within(dlg).getByLabelText('Plan'), '');
    expect(within(dlg).getByText(/vuelve a depender de su prueba: si ya venció, su cuenta queda en pausa/)).toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Quitar plan' }));
    await waitFor(() => expect(api.count('PUT /platform/companies/cafe/plan')).toBe(1));
    expect(api.last('PUT /platform/companies/cafe/plan')?.body).toEqual({ plan_id: null });
  });

  it('cancelar y Escape no llaman a la API; un error del servidor (plan archivado en medio) se muestra en el diálogo', async () => {
    const api = mockApi(server({ extra: { 'PUT /platform/companies/luna/plan': () => err(409, 'PLAN_ARCHIVED', 'El plan está archivado: restáuralo o elige otro') } }));
    renderApp('/platform/companies');
    const { u, dlg } = await open('Estudio Luna');
    await u.click(within(dlg).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Cambiar el plan de Estudio Luna' }));
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.count('PUT /platform/companies/luna/plan')).toBe(0);
    const again = await open('Estudio Luna');
    await again.u.selectOptions(within(again.dlg).getByLabelText('Plan'), 'pro');
    await again.u.click(within(again.dlg).getByRole('button', { name: 'Asignar plan' }));
    expect(await within(again.dlg).findByRole('alert')).toHaveTextContent('El plan está archivado');
  });

  it('sin planes creados lo dice y no deja asignar', async () => {
    mockApi(server({ plans: () => ({ body: planList([]) }) }));
    renderApp('/platform/companies');
    const { dlg } = await open('Estudio Luna');
    expect(within(dlg).getByText(/No hay planes disponibles/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Quitar plan' })).toBeDisabled();
  });
});

describe('Planes', () => {
  it('muestra cada plan con sus límites («ilimitados» si no hay), módulos encendidos y número de empresas', async () => {
    mockApi(server());
    renderApp('/platform/plans');
    const cards = within(await screen.findByRole('list', { name: 'Planes' })).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText('Pro')).toBeInTheDocument();
    expect(within(cards[0]!).getByText('Para equipos')).toBeInTheDocument();
    expect(cards[0]).toHaveTextContent('10 usuarios · 5 conexiones · ilimitados departamentos');
    expect(within(cards[0]!).getByText('2 empresas')).toBeInTheDocument();
    const mods = within(within(cards[0]!).getByLabelText('Módulos de Pro'));
    expect(mods.getByText('Kanban')).toBeInTheDocument();
    expect(mods.getByText('Agentes IA')).toBeInTheDocument();
    expect(mods.queryByText('Campañas')).not.toBeInTheDocument();
    expect(cards[1]).toHaveTextContent('3 usuarios');
    expect(within(cards[1]!).getByText('0 empresas')).toBeInTheDocument();
  });

  it('los archivados solo se muestran si se pide, se pueden restaurar y no se editan', async () => {
    const api = mockApi(server({ extra: { 'POST /platform/plans/viejo/restore': () => ({ body: {} }) } }));
    renderApp('/platform/plans');
    const u = userEvent.setup();
    await screen.findByText('Pro');
    expect(screen.queryByText('Viejo')).not.toBeInTheDocument();
    await u.click(screen.getByLabelText('Mostrar archivados'));
    const old = (await screen.findByText('Viejo')).closest('li')!;
    expect(api.calls.some((c) => c.path === '/platform/plans' && c.query.get('include_archived') === 'true')).toBe(true);
    expect(within(old).getByText('Archivado')).toBeInTheDocument();
    expect(within(old).queryByRole('button', { name: /Editar/ })).not.toBeInTheDocument();
    await u.click(within(old).getByRole('button', { name: 'Restaurar' }));
    await waitFor(() => expect(api.count('POST /platform/plans/viejo/restore')).toBe(1));
  });

  it('archivar: llama a la API y, si el plan está en uso (409), muestra el mensaje del servidor en la tarjeta', async () => {
    const api = mockApi(server({ extra: { 'POST /platform/plans/pro/archive': () => err(409, 'PLAN_IN_USE', 'El plan lo usan 2 empresas: reasígnalas antes de archivarlo'), 'POST /platform/plans/basico/archive': () => ({ body: {} }) } }));
    renderApp('/platform/plans');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Archivar el plan Pro' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El plan lo usan 2 empresas');
    await u.click(screen.getByRole('button', { name: 'Archivar el plan Básico' }));
    await waitFor(() => expect(api.count('POST /platform/plans/basico/archive')).toBe(1));
  });

  it('vacío: invita a crear el primero; error con reintento', async () => {
    let fail = true;
    mockApi(server({ plans: () => (fail ? err(500, 'INTERNAL') : { body: planList([]) }) }));
    renderApp('/platform/plans');
    const u = userEvent.setup();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fail = false;
    await u.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText(/Todavía no hay planes/)).toBeInTheDocument();
  });
});

describe('Crear y editar un plan', () => {
  it('crea: valida nombre y límites en el cliente; el vacío es «ilimitado» (null); envía TODOS los módulos del catálogo', async () => {
    const api = mockApi(server({ extra: { 'POST /platform/plans': () => ({ status: 201, body: plan({ id: 'nuevo', name: 'Equipo' }) }) } }));
    renderApp('/platform/plans');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Nuevo plan' }));
    const dlg = await screen.findByRole('dialog', { name: 'Nuevo plan' });
    await u.type(within(dlg).getByLabelText('Nombre'), 'E');
    await u.type(within(dlg).getByLabelText('Usuarios'), '0');
    await u.type(within(dlg).getByLabelText('Conexiones'), 'diez');
    await u.click(within(dlg).getByRole('button', { name: 'Crear plan' }));
    expect(within(dlg).getByText('Escribe un nombre de al menos 2 caracteres')).toBeInTheDocument();
    expect(within(dlg).getAllByText(/Un número entre 1 y 100\.000, o déjalo vacío para ilimitado/)).toHaveLength(2);
    expect(api.count('POST /platform/plans')).toBe(0);

    await u.type(within(dlg).getByLabelText('Nombre'), 'quipo');
    await u.clear(within(dlg).getByLabelText('Usuarios'));
    await u.type(within(dlg).getByLabelText('Usuarios'), '8');
    await u.clear(within(dlg).getByLabelText('Conexiones'));
    await u.click(within(dlg).getByLabelText('Kanban'));
    await u.click(within(dlg).getByLabelText('Agentes IA'));
    await u.click(within(dlg).getByRole('button', { name: 'Crear plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.last('POST /platform/plans')?.body).toEqual({
      name: 'Equipo', description: null, max_users: 8, max_connections: null, max_queues: null,
      features: { kanban: true, agenda: false, campaigns: false, ai_agents: true },
    });
  });

  it('nombre repetido (409): el error aparece en el campo y el diálogo sigue abierto', async () => {
    mockApi(server({ extra: { 'POST /platform/plans': () => err(409, 'PLAN_NAME_TAKEN', 'Ya existe un plan con ese nombre') } }));
    renderApp('/platform/plans');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Nuevo plan' }));
    const dlg = await screen.findByRole('dialog');
    await u.type(within(dlg).getByLabelText('Nombre'), 'Pro');
    await u.click(within(dlg).getByRole('button', { name: 'Crear plan' }));
    expect(await within(dlg).findByText('Ya existe un plan con ese nombre')).toBeInTheDocument();
    expect(within(dlg).getByLabelText('Nombre')).toHaveAttribute('aria-invalid', 'true');
  });

  it('edita: el formulario trae los valores del plan y guarda con PATCH', async () => {
    const api = mockApi(server({ extra: { 'PATCH /platform/plans/pro': () => ({ body: PRO }) } }));
    renderApp('/platform/plans');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Editar el plan Pro' }));
    const dlg = await screen.findByRole('dialog', { name: 'Editar plan «Pro»' });
    expect(within(dlg).getByLabelText('Nombre')).toHaveValue('Pro');
    expect(within(dlg).getByLabelText('Descripción (opcional)')).toHaveValue('Para equipos');
    expect(within(dlg).getByLabelText('Usuarios')).toHaveValue('10');
    expect(within(dlg).getByLabelText('Departamentos')).toHaveValue('');
    expect(within(dlg).getByLabelText('Kanban')).toBeChecked();
    expect(within(dlg).getByLabelText('Campañas')).not.toBeChecked();
    await u.click(within(dlg).getByLabelText('Campañas'));
    await u.clear(within(dlg).getByLabelText('Descripción (opcional)'));
    await u.click(within(dlg).getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.last('PATCH /platform/plans/pro')?.body).toMatchObject({ name: 'Pro', description: null, max_users: 10, max_connections: 5, max_queues: null, features: { kanban: true, campaigns: true } });
  });
});
