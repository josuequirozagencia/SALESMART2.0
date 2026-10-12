import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformTrialItem, PlatformTrialList } from '../src/lib/types';
import { anon, authed, err, loginReply, ME_ADMIN, ME_ROOT, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const DAY = 86_400_000;
const item = (over: Partial<PlatformTrialItem> & { id: string }, ext: Partial<PlatformTrialItem['extension']> = {}): PlatformTrialItem => ({
  organization_id: `org-${over.id}`,
  organization_name: `Empresa ${over.id}`,
  owner_email: `${over.id}@empresa.test`,
  owner_name: `Titular ${over.id}`,
  owner_phone: '+593984217730',
  plan_name: null,
  status: 'active',
  started_at: new Date(Date.now() - 2 * DAY).toISOString(),
  ends_at: new Date(Date.now() + 5 * DAY).toISOString(),
  ...over,
  extension: { status: 'none', can_request: true, requested_at: null, decided_at: null, days_granted: null, reason: null, ...ext },
});
const SUMMARY = { active: 7, expiring_soon: 2, pending: 3, extension_days: 3 };
const list = (items: PlatformTrialItem[], over: Partial<PlatformTrialList> = {}): PlatformTrialList => ({ items, next_cursor: null, pending_extensions: SUMMARY.pending, summary: SUMMARY, ...over });

const PENDING = item({ id: 'p1', organization_name: 'Estudio Luna', owner_name: 'Ana Luna', owner_email: 'ana@estudioluna.test', ends_at: new Date(Date.now() + 1 * DAY).toISOString() }, { status: 'pending', reason: 'Estoy conectando mi WhatsApp y aún no alcanzo a probar los agentes' });
const EXPIRED = item({ id: 'e1', organization_name: 'Taller Pérez', status: 'expired', ends_at: new Date(Date.now() - 2 * DAY).toISOString() }, { status: 'pending', reason: 'Necesito terminar la migración' });
const APPROVED = item({ id: 'a1', organization_name: 'Café Origen' }, { status: 'approved', days_granted: 3, reason: 'Migración de contactos' });
const DENIED = item({ id: 'd1', organization_name: 'Barbería Norte' }, { status: 'denied', reason: 'Sin motivo claro' });

/** Súper Admin con sesión recuperable + servidor de la consola. */
const EMPTY_COMPANIES = { items: [], next_cursor: null };
const root = (trials: Handler): Record<string, Handler> => ({ ...authed(ME_ROOT, null), 'GET /platform/trials': trials, 'GET /platform/companies': () => ({ body: EMPTY_COMPANIES }), 'GET /platform/plans': () => ({ body: { items: [], feature_catalog: [] } }) });

describe('Consola de plataforma · pestaña Pruebas', () => {
  it('el Súper Admin que inicia sesión llega a la consola (pestaña Empresas) con la insignia de pendientes junto a «Pruebas»', async () => {
    const api = mockApi({ ...anon(), 'POST /auth/login': () => loginReply(ME_ROOT), 'GET /platform/trials': () => ({ body: list([PENDING]) }), 'GET /platform/companies': () => ({ body: EMPTY_COMPANIES }) });
    renderApp('/login');
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText('Correo'), 'root@plataforma.test');
    await u.type(screen.getByLabelText('Contraseña'), 'Clave-Segura-1');
    await u.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('heading', { name: 'Consola de plataforma' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Secciones de la consola' });
    expect(within(nav).getByRole('link', { name: 'Empresas' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Planes' })).toHaveAttribute('href', '/platform/plans');
    expect(await within(nav).findByLabelText('3 solicitudes pendientes')).toHaveTextContent('3');
    expect(api.count('GET /trials/me')).toBe(0); // el Súper Admin no tiene prueba
  });

  it('por defecto muestra las solicitudes PENDIENTES; resumen global de la plataforma', async () => {
    const api = mockApi(root(() => ({ body: list([PENDING, EXPIRED]) })));
    renderApp('/platform/trials');
    expect(await screen.findByText('Estudio Luna')).toBeInTheDocument();
    expect(screen.getByText('Taller Pérez')).toBeInTheDocument();
    const call = api.calls.find((c) => c.path === '/platform/trials' && c.query.get('extension') === 'pending')!;
    expect(call.query.get('limit')).toBe('25');
    const kpis = screen.getByRole('group', { name: 'Resumen de pruebas' });
    expect(within(kpis).getByTestId('kpi-Pruebas activas')).toHaveTextContent('7');
    expect(within(kpis).getByTestId('kpi-Vencen en menos de 2 días')).toHaveTextContent('2');
    expect(within(kpis).getByTestId('kpi-Solicitudes pendientes')).toHaveTextContent('3');
    expect(screen.getByRole('tab', { name: /Solicitudes pendientes \(3\)/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('cada fila muestra empresa, titular, WhatsApp (enlace seguro), fechas, estado y el motivo; solo las pendientes tienen acciones', async () => {
    mockApi(root(() => ({ body: list([PENDING, EXPIRED, APPROVED, DENIED]) })));
    renderApp('/platform/trials');
    const rows = within(await screen.findByRole('list', { name: 'Pruebas' })).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    const luna = rows[0]!;
    expect(within(luna).getByText('Estudio Luna')).toBeInTheDocument();
    expect(within(luna).getByText('ana@estudioluna.test')).toBeInTheDocument();
    expect(within(luna).getByText('Ana Luna')).toBeInTheDocument();
    const wa = within(luna).getByRole('link', { name: /Escribir por WhatsApp a Ana Luna/ });
    expect(wa).toHaveAttribute('href', 'https://wa.me/593984217730');
    expect(wa).toHaveAttribute('target', '_blank');
    expect(wa).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(within(luna).getByText(/Estoy conectando mi WhatsApp/)).toBeInTheDocument();
    expect(within(luna).getByText('Pendiente')).toBeInTheDocument();
    expect(within(luna).getByText(/^\d+ h|menos de 1 h|1 día/)).toBeInTheDocument(); // le queda ~1 día → aviso
    expect(within(rows[1]!).getByText('Vencida')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Aprobada +3 d')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Rechazada')).toBeInTheDocument();
    expect(within(luna).getByRole('button', { name: 'Aprobar la extensión de Estudio Luna' })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: 'Rechazar la extensión de Taller Pérez' })).toBeInTheDocument();
    for (const r of [rows[2]!, rows[3]!]) expect(within(r).queryByRole('button')).not.toBeInTheDocument();
  });

  it('los filtros piden a la API lo correcto (extension / state) y cambian de lista', async () => {
    const api = mockApi(root((c) => ({ body: list(c.query.get('state') === 'expired' ? [EXPIRED] : c.query.get('extension') === 'pending' ? [PENDING] : [PENDING, APPROVED]) })));
    renderApp('/platform/trials');
    const u = userEvent.setup();
    await screen.findByText('Estudio Luna');
    await u.click(screen.getByRole('tab', { name: 'Todas' }));
    expect(await screen.findByText('Café Origen')).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === '/platform/trials' && !c.query.has('extension') && !c.query.has('state') && c.query.get('limit') === '25')).toBe(true);
    await u.click(screen.getByRole('tab', { name: 'Activas' }));
    await waitFor(() => expect(api.calls.some((c) => c.query.get('state') === 'active')).toBe(true));
    await u.click(screen.getByRole('tab', { name: 'Vencidas' }));
    expect(await screen.findByText('Taller Pérez')).toBeInTheDocument();
    expect(api.calls.some((c) => c.query.get('state') === 'expired')).toBe(true);
    expect(screen.getByRole('tab', { name: 'Vencidas' })).toHaveAttribute('aria-selected', 'true');
  });

  it('paginación por cursor: «Cargar más» pide la siguiente página con el cursor y la añade sin repetir', async () => {
    const api = mockApi(root((c) => (c.query.get('cursor') ? { body: list([APPROVED, DENIED]) } : { body: list([PENDING, EXPIRED], { next_cursor: 'cursor-2' }) })));
    renderApp('/platform/trials');
    const u = userEvent.setup();
    await screen.findByText('Estudio Luna');
    await u.click(screen.getByRole('button', { name: 'Cargar más' }));
    expect(await screen.findByText('Café Origen')).toBeInTheDocument();
    expect(api.calls.some((c) => c.query.get('cursor') === 'cursor-2')).toBe(true);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).not.toBeInTheDocument();
  });

  it('estados vacío y de error: mensajes claros, «Ver todas» y reintentar', async () => {
    let fail = true;
    mockApi(root(() => (fail ? err(500, 'INTERNAL') : { body: list([]) })));
    renderApp('/platform/trials');
    const u = userEvent.setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('Tuvimos un problema de nuestro lado');
    fail = false;
    await u.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('No hay solicitudes de extensión pendientes.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Ver todas' }));
    expect(await screen.findByText('Todavía no hay pruebas.')).toBeInTheDocument();
  });

  it('sin solicitudes pendientes la insignia desaparece', async () => {
    mockApi(root(() => ({ body: list([], { pending_extensions: 0, summary: { ...SUMMARY, pending: 0 } }) })));
    renderApp('/platform/trials');
    await screen.findByText('No hay solicitudes de extensión pendientes.');
    expect(screen.queryByLabelText(/solicitudes pendientes$/)).not.toBeInTheDocument();
  });
});

describe('Decidir una extensión', () => {
  const setup = (decide: Handler = () => ({ body: {} })) => {
    let pendingLeft = true;
    const api = mockApi({
      ...root((c) => ({ body: list(c.query.get('extension') === 'pending' && !pendingLeft ? [] : [PENDING, EXPIRED]) })),
      'POST /platform/trials/p1/approve': (c) => { pendingLeft = false; return decide(c); },
      'POST /platform/trials/p1/deny': (c) => { pendingLeft = false; return decide(c); },
      'POST /platform/trials/e1/approve': (c) => decide(c),
    });
    return api;
  };

  it('aprobar antes de vencer: explica que SUMA los días configurados, pide confirmación y llama a la API', async () => {
    const api = setup();
    renderApp('/platform/trials');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Aprobar la extensión de Estudio Luna' }));
    const dlg = screen.getByRole('dialog', { name: 'Aprobar extensión' });
    expect(within(dlg).getByText(/Estudio Luna/)).toBeInTheDocument();
    expect(within(dlg).getByText(/Se suman 3 días al final de la prueba/)).toBeInTheDocument();
    expect(within(dlg).getByText(/Estoy conectando mi WhatsApp/)).toBeInTheDocument();
    expect(within(dlg).getByText(/no se puede deshacer/)).toBeInTheDocument();
    expect(api.count('POST /platform/trials/p1/approve')).toBe(0); // todavía no se decidió nada
    await u.click(within(dlg).getByRole('button', { name: 'Aprobar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.count('POST /platform/trials/p1/approve')).toBe(1);
    expect(await screen.findByText('No hay solicitudes de extensión pendientes.')).toBeInTheDocument(); // la lista se refrescó
  });

  it('aprobar una prueba YA vencida: explica que cuenta desde hoy y la cuenta se reactiva', async () => {
    const api = setup();
    renderApp('/platform/trials');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Aprobar la extensión de Taller Pérez' }));
    expect(screen.getByText(/ya venció: los 3 días cuentan desde hoy y la cuenta se reactiva/)).toBeInTheDocument();
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Aprobar' }));
    await waitFor(() => expect(api.count('POST /platform/trials/e1/approve')).toBe(1));
  });

  it('rechazar: explica que la prueba no cambia y que no podrá volver a pedirla; llama a /deny', async () => {
    const api = setup();
    renderApp('/platform/trials');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Rechazar la extensión de Estudio Luna' }));
    const dlg = screen.getByRole('dialog', { name: 'Rechazar extensión' });
    expect(within(dlg).getByText(/La prueba no cambia\. La cuenta no podrá volver a pedir una extensión/)).toBeInTheDocument();
    await u.click(within(dlg).getByRole('button', { name: 'Rechazar' }));
    await waitFor(() => expect(api.count('POST /platform/trials/p1/deny')).toBe(1));
    expect(api.count('POST /platform/trials/p1/approve')).toBe(0);
  });

  it('Cancelar y Escape cierran el diálogo SIN llamar a la API', async () => {
    const api = setup();
    renderApp('/platform/trials');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Aprobar la extensión de Estudio Luna' }));
    await u.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Rechazar la extensión de Estudio Luna' }));
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/platform/trials/'))).toHaveLength(0);
  });

  it('si otra persona ya la resolvió (409) lo dice, refresca la lista y no deja el diálogo en un estado raro', async () => {
    const api = setup(() => err(409, 'EXTENSION_NOT_PENDING'));
    renderApp('/platform/trials');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Aprobar la extensión de Estudio Luna' }));
    const before = api.count('GET /platform/trials');
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Aprobar' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('ya fue resuelta');
    await waitFor(() => expect(api.count('GET /platform/trials')).toBeGreaterThan(before));
  });
});

describe('Acceso a la consola', () => {
  it('una persona sin sesión es enviada al login', async () => {
    mockApi(anon());
    renderApp('/platform/trials');
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument();
  });

  it('un administrador de cliente que abre /platform/trials vuelve a su inicio y NO se consulta nada de plataforma', async () => {
    const api = mockApi(authed(ME_ADMIN));
    renderApp('/platform/trials');
    expect(await screen.findByRole('heading', { name: /Hola, Mi Empresa SA/ })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path.startsWith('/platform'))).toHaveLength(0);
  });

  it('el Súper Admin que abre la raíz es llevado a la consola (Empresas) y puede ir a Pruebas', async () => {
    mockApi(root(() => ({ body: list([PENDING]) })));
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Consola de plataforma' })).toBeInTheDocument();
    expect(await screen.findByText('Todavía no hay empresas.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('link', { name: /Pruebas/ }));
    expect(await screen.findByText('Estudio Luna')).toBeInTheDocument();
  });
});
