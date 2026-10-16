import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessLevel, AccessSession, AccessSessionList, Agency, Company, CompanyCreated, CompanyList, ContextOption, Me } from '../src/lib/types';
import { authed, err, ME_AGENCY, ME_AGENCY_IN_CLIENT, ME_ROOT, ME_ROOT_IN_CLIENT, mockApi, renderApp, resetWorld, trial, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const company = (over: Partial<Company> & { id: string; name: string }): Company => ({ kind: 'client', state: 'active', plan: null, agency: { id: 'ag1', name: 'Agencia Uno' }, agency_access_level: 'admin', users: 1, owner_email: `${over.id}@cliente.test`, timezone: 'UTC', country: 'EC', invitation: null, created_at: new Date().toISOString(), trial_ends_at: null, ...over });
const A = company({ id: 'c1', name: 'Barbería Norte' });
const B = company({ id: 'c2', name: 'Estudio Luna', state: 'trial', trial_ends_at: new Date(Date.now() + 3 * 86_400_000).toISOString() });
const INV = company({ id: 'c3', name: 'Gimnasio Sol', state: 'invited', owner_email: 'dueno@gimnasio.test', invitation: { email: 'dueno@gimnasio.test', expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), expired: false } });
const SUSP = company({ id: 'c4', name: 'Taller Pérez', state: 'suspended' });
const clist = (items: Company[], next: string | null = null): CompanyList => ({ items, next_cursor: next });
const sent = (email = 'dueno@nuevo.test') => ({ email, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), delivery: 'sent' as const });
const OPTIONS: ContextOption[] = [{ id: 'c1', name: 'Barbería Norte', role: 'agency', access_level: 'admin' }, { id: 'c2', name: 'Estudio Luna', role: 'agency', access_level: 'read' }];

/** Servidor de una agencia: el contexto cambia con `POST /context/switch` como en el servidor real (y `/auth/me` lo refleja al recargar). */
function agencyServer(extra: Record<string, Handler> = {}, trialOf: ReturnType<typeof trial> | null = trial()) {
  let ctx: Me = ME_AGENCY;
  const names: Record<string, string> = { c1: 'Barbería Norte', c2: 'Estudio Luna' };
  const levels: Record<string, AccessLevel> = { c1: 'admin', c2: 'read' };
  return {
    ...authed(ME_AGENCY, trialOf),
    'GET /auth/me': () => ({ body: ctx }),
    'GET /agency/clients': () => ({ body: clist([A, B, INV, SUSP]) }),
    'GET /context/options': ({ query }) => ({ body: { items: OPTIONS.filter((o) => o.id !== ctx.organization.id && o.name.toLowerCase().includes((query.get('q') ?? '').toLowerCase())) } }),
    'POST /context/switch': ({ body }) => {
      const target = (body as { target: string | null }).target;
      if (target === 'denegado') return err(404, 'NOT_FOUND');
      ctx = target === null ? ME_AGENCY : { ...ME_AGENCY_IN_CLIENT, organization: { id: target, name: names[target] ?? 'Otro', kind: 'client' }, access_level: levels[target] ?? 'admin', read_only: levels[target] === 'read' };
      return { body: ctx };
    },
    ...extra,
  } satisfies Record<string, Handler>;
}

const banner = () => screen.findByRole('region', { name: 'Contexto de acceso' });

describe('La agencia: «Mis clientes» y cambio de contexto', () => {
  it('la agencia aterriza en «Mis clientes» con su cartera, el nivel de su acceso y las acciones de cada estado', async () => {
    mockApi(agencyServer());
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Mis clientes' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Contexto de acceso' })).not.toBeInTheDocument(); // en su propia agencia no hay banner
    const rows = within(await screen.findByRole('list', { name: 'Clientes' })).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('Activa')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Tu acceso: Administrador')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Entrar a Barbería Norte' })).toBeInTheDocument();
    expect(within(rows[1]!).getByText('En prueba')).toBeInTheDocument();
    const inv = rows[2]!;
    expect(within(inv).getByText('Invitación pendiente')).toBeInTheDocument();
    expect(within(inv).getByRole('button', { name: 'Reenviar la invitación de Gimnasio Sol' })).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Suspendida')).toBeInTheDocument();
    expect(within(rows[3]!).queryByRole('button', { name: /Entrar a/ })).not.toBeInTheDocument(); // un cliente suspendido no se entra
  });

  it('«Entrar» cambia de contexto SIN cerrar sesión: banner «Administrando X» con el nivel, y «Volver a mi agencia» regresa a la lista', async () => {
    const api = mockApi(agencyServer());
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Entrar a Barbería Norte' }));
    const b = await banner();
    expect(b).toHaveTextContent('Administrando Barbería Norte');
    expect(b).toHaveTextContent('Administrador');
    expect(await screen.findByRole('heading', { name: /Hola, Barbería Norte/ })).toBeInTheDocument();
    expect(api.last('POST /context/switch')?.body).toEqual({ target: 'c1' });
    expect(api.count('POST /auth/logout')).toBe(0);

    await u.click(within(b).getByRole('button', { name: 'Volver a mi agencia' }));
    expect(await screen.findByRole('heading', { name: 'Mis clientes' })).toBeInTheDocument();
    expect(api.last('POST /context/switch')?.body).toEqual({ target: null });
    expect(screen.queryByRole('region', { name: 'Contexto de acceso' })).not.toBeInTheDocument();
  });

  it('«Cambiar de cliente»: selector con buscador que no ofrece el cliente actual; entrar a otro actualiza el banner', async () => {
    const api = mockApi(agencyServer());
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Entrar a Barbería Norte' }));
    await u.click(within(await banner()).getByRole('button', { name: 'Cambiar de cliente' }));
    const dlg = await screen.findByRole('dialog', { name: 'Cambiar de cliente' });
    expect(await within(dlg).findByRole('button', { name: 'Entrar a Estudio Luna' })).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: 'Entrar a Barbería Norte' })).not.toBeInTheDocument();
    expect(within(dlg).getByText('Solo lectura')).toBeInTheDocument();

    await u.type(within(dlg).getByLabelText('Buscar cliente'), 'zzz');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/context/options' && c.query.get('q') === 'zzz')).toBe(true));
    expect(await within(dlg).findByText('Ningún cliente coincide con la búsqueda.')).toBeInTheDocument();
    await u.clear(within(dlg).getByLabelText('Buscar cliente'));
    await u.click(await within(dlg).findByRole('button', { name: 'Entrar a Estudio Luna' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const b = await banner();
    expect(b).toHaveTextContent('Administrando Estudio Luna');
    expect(b).toHaveTextContent('Solo lectura');
    expect(api.last('POST /context/switch')?.body).toEqual({ target: 'c2' });
  });

  it('si el acceso ya no existe, el servidor responde 404 y la web lo dice sin cambiar de contexto', async () => {
    mockApi(agencyServer({ 'GET /agency/clients': () => ({ body: clist([company({ id: 'denegado', name: 'Cliente Quitado' })]) }) }));
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Entrar a Cliente Quitado' }));
    expect(await screen.findByText(/Ya no tienes acceso a ese cliente/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mis clientes' })).toBeInTheDocument();
  });

  it('con la prueba del cliente vencida la agencia ve la empresa en SOLO LECTURA (no la pantalla de «vencida»)', async () => {
    mockApi({ ...authed({ ...ME_AGENCY_IN_CLIENT, read_only: true }, trial({ status: 'expired', ends_at: new Date(Date.now() - 86_400_000).toISOString() })) });
    renderApp('/');
    const b = await banner();
    expect(b).toHaveTextContent('Administrando Barbería Norte');
    expect(b).toHaveTextContent('Solo lectura: la prueba de esta empresa venció');
    expect(await screen.findByRole('heading', { name: /Hola, Barbería Norte/ })).toBeInTheDocument();
    expect(screen.queryByText(/Tu período de prueba terminó/)).not.toBeInTheDocument();
  });

  it('al recargar la página la sesión conserva el contexto (lo trae /auth/me del servidor)', async () => {
    mockApi({ ...authed(ME_AGENCY_IN_CLIENT) });
    renderApp('/');
    expect(await banner()).toHaveTextContent('Administrando Barbería Norte');
  });

  it('un administrador de cliente normal no ve banner ni la consola de agencia', async () => {
    const { ME_ADMIN } = await import('./helpers');
    mockApi({ ...authed(ME_ADMIN) });
    renderApp('/agency/clients');
    expect(await screen.findByRole('heading', { name: /Hola, Mi Empresa SA/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Contexto de acceso' })).not.toBeInTheDocument();
  });
});

describe('«Registrar cliente»', () => {
  const out: CompanyCreated = { company: { id: 'c9', name: 'Panadería Sol', kind: 'client', state: 'invited', plan: null, timezone: 'America/Guayaquil', country: 'EC' }, invitation: sent() };

  it('diálogo SIN plan: registra con el cuerpo normalizado (sin plan ni agencia), avisa de la invitación y refresca la lista', async () => {
    const api = mockApi(agencyServer({ 'POST /agency/clients': () => ({ status: 201, body: out }) }));
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Registrar cliente' }));
    const dlg = await screen.findByRole('dialog', { name: 'Registrar cliente' });
    expect(within(dlg).queryByLabelText('Plan')).not.toBeInTheDocument();
    await u.type(within(dlg).getByLabelText('Nombre del cliente'), 'Panadería Sol');
    await u.type(within(dlg).getByLabelText('Correo del dueño'), ' Dueno@Nuevo.TEST ');
    await u.click(within(dlg).getByRole('button', { name: 'Registrar e invitar' }));
    const done = await screen.findByRole('dialog', { name: 'Cliente registrado' });
    expect(done).toHaveTextContent('Enviamos la invitación');
    expect(api.last('POST /agency/clients')?.body).toEqual({ name: 'Panadería Sol', owner_email: 'dueno@nuevo.test', timezone: 'America/Guayaquil', country: 'EC' });
    await waitFor(() => expect(api.count('GET /agency/clients')).toBeGreaterThanOrEqual(2));
  });

  it('valida en el navegador y muestra el error del servidor', async () => {
    const api = mockApi(agencyServer({ 'POST /agency/clients': () => err(500, 'INTERNAL') }));
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Registrar cliente' }));
    const dlg = await screen.findByRole('dialog', { name: 'Registrar cliente' });
    await u.click(within(dlg).getByRole('button', { name: 'Registrar e invitar' }));
    expect(await within(dlg).findByText('Escribe el nombre de la empresa')).toBeInTheDocument();
    expect(api.count('POST /agency/clients')).toBe(0);
    await u.type(within(dlg).getByLabelText('Nombre del cliente'), 'Panadería Sol');
    await u.type(within(dlg).getByLabelText('Correo del dueño'), 'dueno@nuevo.test');
    await u.click(within(dlg).getByRole('button', { name: 'Registrar e invitar' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Tuvimos un problema de nuestro lado');
  });

  it('si el correo no pudo salir, muestra el enlace para entregarlo por otro medio', async () => {
    mockApi(agencyServer({ 'POST /agency/clients': () => ({ status: 201, body: { ...out, invitation: { ...sent(), delivery: 'failed', invite_url: 'https://app.ejemplo.test/accept-invite#token=abc.def' } } }) }));
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Registrar cliente' }));
    const dlg = await screen.findByRole('dialog', { name: 'Registrar cliente' });
    await u.type(within(dlg).getByLabelText('Nombre del cliente'), 'Panadería Sol');
    await u.type(within(dlg).getByLabelText('Correo del dueño'), 'dueno@nuevo.test');
    await u.click(within(dlg).getByRole('button', { name: 'Registrar e invitar' }));
    expect(await screen.findByLabelText('Enlace de invitación')).toHaveValue('https://app.ejemplo.test/accept-invite#token=abc.def');
  });

  it('«Reenviar invitación» de un cliente pendiente usa la ruta de la agencia y muestra el resultado', async () => {
    const api = mockApi(agencyServer({ 'POST /agency/clients/c3/invitation/resend': () => ({ body: sent('dueno@gimnasio.test') }) }));
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Reenviar la invitación de Gimnasio Sol' }));
    const dlg = await screen.findByRole('dialog', { name: 'Invitación de Gimnasio Sol' });
    expect(dlg).toHaveTextContent('Enviamos la invitación');
    expect(api.count('POST /agency/clients/c3/invitation/resend')).toBe(1);
  });

  it('la búsqueda y el estado se piden a la API; «Cargar más» usa el cursor', async () => {
    const api = mockApi(agencyServer({ 'GET /agency/clients': ({ query }) => ({ body: query.get('cursor') ? clist([B]) : clist([A], 'c1') }) }));
    renderApp('/');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Cargar más' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/agency/clients' && c.query.get('cursor') === 'c1')).toBe(true));
    await u.selectOptions(await screen.findByLabelText('Estado'), 'invited');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/agency/clients' && c.query.get('state') === 'invited')).toBe(true));
    await u.type(screen.getByLabelText('Buscar'), 'sol');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/agency/clients' && c.query.get('q') === 'sol')).toBe(true));
    // la lista nunca manda un identificador de organización: la cartera la acota el servidor
    for (const c of api.calls.filter((x) => x.path === '/agency/clients')) {
      expect([...c.query.keys()].every((k) => ['q', 'state', 'limit', 'cursor'].includes(k))).toBe(true);
    }
  });
});

describe('Súper Admin: soporte y Accesos', () => {
  const NO_TRIALS = { items: [], next_cursor: null, pending_extensions: 0, summary: { active: 0, expiring_soon: 0, pending: 0, extension_days: 3 } };
  const platform = (extra: Record<string, Handler> = {}) => {
    let ctx: Me = ME_ROOT;
    return {
      ...authed(ME_ROOT, null),
      'GET /auth/me': () => ({ body: ctx }),
      'GET /platform/trials': () => ({ body: NO_TRIALS }),
      'GET /platform/plans': () => ({ body: { items: [], feature_catalog: [] } }),
      'GET /platform/agencies': () => ({ body: { items: [], next_cursor: null } }),
      'GET /platform/companies': () => ({ body: clist([A, SUSP, company({ id: 'ag1', name: 'Agencia Uno', kind: 'agency', agency: null, agency_access_level: null })]) }),
      'POST /context/switch': ({ body }) => {
        const target = (body as { target: string | null }).target;
        ctx = target === null ? ME_ROOT : { ...ME_ROOT_IN_CLIENT, organization: { id: target, name: 'Barbería Norte', kind: 'client' } };
        return { body: ctx };
      },
      'GET /trials/me': () => err(404, 'NOT_FOUND'),
      ...extra,
    } satisfies Record<string, Handler>;
  };

  it('«Entrar» (soporte): el Súper Admin entra a una empresa, ve el banner «Soporte» y vuelve a la plataforma; una suspendida no se entra', async () => {
    const api = mockApi(platform());
    renderApp('/platform/companies');
    const u = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Empresas' });
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[1]!).queryByRole('button', { name: /Entrar a/ })).not.toBeInTheDocument();
    await u.click(within(rows[0]!).getByRole('button', { name: 'Entrar a Barbería Norte (soporte)' }));
    const b = await banner();
    expect(b).toHaveTextContent('Soporte: estás dentro de Barbería Norte');
    expect(within(b).queryByRole('button', { name: 'Cambiar de cliente' })).not.toBeInTheDocument(); // eso es de las agencias
    expect(api.last('POST /context/switch')?.body).toEqual({ target: 'c1' });

    await u.click(within(b).getByRole('button', { name: 'Volver a la plataforma' }));
    expect(await screen.findByRole('button', { name: 'Nueva empresa' })).toBeInTheDocument();
    expect(api.last('POST /context/switch')?.body).toEqual({ target: null });
  });

  it('dentro de una empresa la consola de plataforma NO se muestra aunque se escriba la dirección', async () => {
    mockApi({ ...authed(ME_ROOT_IN_CLIENT, null), 'GET /trials/me': () => err(404, 'NOT_FOUND') });
    renderApp('/platform/companies');
    expect(await banner()).toHaveTextContent('Soporte');
    expect(await screen.findByRole('heading', { name: /Hola, Barbería Norte/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nueva empresa' })).not.toBeInTheDocument();
  });

  it('en una agencia en soporte el Súper Admin ve «Mis clientes» con el banner para volver', async () => {
    const inAgency: Me = { ...ME_ROOT, organization: { id: 'ag1', name: 'Agencia Uno', kind: 'agency' }, acting_as: 'super_admin' };
    mockApi({ ...authed(inAgency, null), 'GET /agency/clients': () => ({ body: clist([A]) }) });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Mis clientes' })).toBeInTheDocument();
    expect(await banner()).toHaveTextContent('Soporte: estás dentro de Agencia Uno');
  });

  it('la pestaña «Accesos» lista quién entró, a dónde y cuánto, con filtros y «Cargar más»', async () => {
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const item = (over: Partial<AccessSession> & { id: string }): AccessSession => ({ actor: { email: 'dave@agencia.test', name: 'Dave Agencia' }, actor_role: 'agency', organization: { id: 'c1', name: 'Barbería Norte', kind: 'client' }, started_at: at(30), ended_at: at(20), end_reason: 'return', open: false, duration_seconds: 600, ...over });
    const page1: AccessSessionList = { items: [item({ id: 'x1', ended_at: null, end_reason: null, open: true, duration_seconds: 1800 }), item({ id: 'x2', actor: { email: 'root@plataforma.test', name: null }, actor_role: 'super_admin', end_reason: 'access_removed' })], next_cursor: 'cur1' };
    const page2: AccessSessionList = { items: [item({ id: 'x3', end_reason: 'session_ended', duration_seconds: 7500 })], next_cursor: null };
    const api = mockApi(platform({ 'GET /platform/access-sessions': ({ query }) => ({ body: query.get('cursor') ? page2 : page1 }) }));
    renderApp('/platform/access');
    const u = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Accesos' })).toHaveAttribute('href', '/platform/access');
    const rows = within(await screen.findByRole('list', { name: 'Accesos' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Dave Agencia')).toBeInTheDocument();
    expect(within(rows[0]!).getAllByText('Dentro ahora').length).toBeGreaterThan(0);
    expect(within(rows[1]!).getByText(/Se le quitó el acceso/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('root@plataforma.test')).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Cargar más' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Accesos' })).getAllByRole('listitem')).toHaveLength(3));
    expect(screen.getByText(/Cerró o venció su sesión/)).toBeInTheDocument();
    expect(screen.getByText('2 h 05 min')).toBeInTheDocument();
    expect(api.last('GET /platform/access-sessions')?.query.get('cursor')).toBe('cur1');

    await u.selectOptions(screen.getByLabelText('Quién entró'), 'agency');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/platform/access-sessions' && c.query.get('actor_role') === 'agency')).toBe(true));
    await u.click(screen.getByLabelText('Solo los que siguen dentro'));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/platform/access-sessions' && c.query.get('open') === 'true')).toBe(true));
    await u.type(screen.getByLabelText('Buscar'), 'dave');
    await waitFor(() => expect(api.calls.some((c) => c.path === '/platform/access-sessions' && c.query.get('q') === 'dave')).toBe(true));
  });

  it('sin entradas explica que todavía nadie entró; un error de carga se puede reintentar', async () => {
    let n = 0;
    mockApi(platform({ 'GET /platform/access-sessions': () => (++n === 1 ? err(500, 'INTERNAL') : { body: { items: [], next_cursor: null } }) }));
    renderApp('/platform/access');
    const u = userEvent.setup();
    expect(await screen.findByText(/Tuvimos un problema de nuestro lado/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Todavía nadie ha entrado a otra cuenta.')).toBeInTheDocument();
  });

  it('la cartera de una agencia permite fijar el nivel de acceso por cliente y avisa cuándo rige', async () => {
    const UNO: Agency = { id: 'ag1', name: 'Agencia Uno', state: 'active', owner_email: 'dave@agencia.test', clients: 1, timezone: 'UTC', country: 'EC', created_at: new Date().toISOString(), invitation: null };
    const api = mockApi(platform({
      'GET /platform/agencies': () => ({ body: { items: [UNO], next_cursor: null } }),
      'GET /platform/agencies/ag1/history': () => ({ body: { items: [] } }),
      'PUT /platform/organizations/c1/agency-access': () => ({ body: { id: 'c1', level: 'read', changed: true } }),
    }));
    renderApp('/platform/agencies');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Cartera de Agencia Uno' }));
    const dlg = await screen.findByRole('dialog', { name: 'Cartera de Agencia Uno' });
    const level = await within(dlg).findByLabelText('Nivel de acceso de la agencia a Barbería Norte');
    expect(level).toHaveValue('admin');
    await u.selectOptions(level, 'read');
    expect(await within(dlg).findByText(/ahora entra a Barbería Norte con el nivel «Solo lectura»/)).toBeInTheDocument();
    expect(api.last('PUT /platform/organizations/c1/agency-access')?.body).toEqual({ level: 'read' });
  });
});
