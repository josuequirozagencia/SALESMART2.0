import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inTemplate, isOn, lockedReason, sameOverrides, toggle } from '../src/features/team/permissions';
import type { PermissionCatalog, PermissionItem, PermissionOverrides, TeamInvitation, TeamMember, TeamMemberFull, WeekHours } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_ADVISOR, mockApi, renderApp, resetWorld, type Handler } from './helpers';

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const item = (key: string, over: Partial<PermissionItem> = {}): PermissionItem => ({ key, label: key, hint: `Ayuda de ${key}`, reach: 'own', in_role: { client_admin: true, advisor: false }, grantable_to_advisor: true, holder_can_grant: true, ...over });
const CATALOG: PermissionCatalog = {
  roles: [{ id: 'client_admin', label: 'Administrador', description: 'Administra toda la empresa y ve a todos.' }, { id: 'advisor', label: 'Asesor', description: 'Atiende a sus clientes: ve solo lo suyo y lo que le comparten.' }],
  groups: [
    { id: 'conversations', label: 'Conversaciones', items: [item('inbox.reply', { label: 'Responder conversaciones', in_role: { client_admin: true, advisor: true } }), item('inbox.view_all', { label: 'Ver todas las conversaciones', reach: 'all', grantable_to_advisor: false })] },
    { id: 'contacts', label: 'Contactos', items: [item('contacts.export', { label: 'Exportar contactos' })] },
    { id: 'team', label: 'Equipo', items: [item('users.manage', { label: 'Administrar usuarios', reach: 'config', grantable_to_advisor: false })] },
  ],
};

const member = (user_id: string, name: string, over: Partial<TeamMember> = {}): TeamMember => ({ user_id, name, email: `${name.split(' ')[0]!.toLowerCase()}@empresa.test`, phone: null, role: 'advisor', status: 'active', joined_at: '2026-10-01T10:00:00.000Z', deactivated_at: null, custom_permissions: false, last_access_at: null, departments: [], ...over });
const base = (): TeamMember[] => [
  member('u1', 'Ana Pérez', { role: 'client_admin', last_access_at: '2026-10-30T12:00:00.000Z' }),
  member('u2', 'Luis Navas', { custom_permissions: true, departments: [{ id: 'q1', name: 'Ventas', color: '#7c5cfa' }] }),
  member('u3', 'Eva Mora', { status: 'deactivated', deactivated_at: '2026-10-20T10:00:00.000Z' }),
];
const inv = (over: Partial<TeamInvitation> = {}): TeamInvitation => ({ id: 'i1', email: 'nora@empresa.test', role: 'advisor', expires_at: '2026-11-06T10:00:00.000Z', expired: false, sent_count: 1, last_sent_at: '2026-10-30T10:00:00.000Z', setup: { grant: [], deny: [], queue_ids: [] }, ...over });
const queue = (id: string, name: string) => ({ id, name, color: '#7c5cfa', distribution_on: false, mode: 'equal', batch: 1, daily_cap: 0, only_unassigned: true, respect_hours: false, reassign_minutes: 0, max_rotations: 3, greeting: null, out_of_hours_message: null, auto_close_hours: 0, hours: null, open_now: true, members: [], channels: [], unassigned_count: 0, created_at: '', updated_at: '' });

interface Calls { invites: unknown[]; roles: unknown[]; perms: unknown[]; depts: unknown[]; hours: unknown[]; leaves: Array<{ kind: string; body: unknown }>; reactivated: string[]; revoked: string[]; resent: string[]; cancelled: string[] }
function server(o: { members?: TeamMember[]; invitations?: TeamInvitation[]; open?: number; inviteDelivery?: 'sent' | 'unavailable' } = {}) {
  const st = { members: o.members ?? base(), invitations: o.invitations ?? [], calls: { invites: [], roles: [], perms: [], depts: [], hours: [], leaves: [], reactivated: [], revoked: [], resent: [], cancelled: [] } as Calls, overrides: {} as Record<string, PermissionOverrides>, hours: {} as Record<string, WeekHours | null> };
  const full = (m: TeamMember): TeamMemberFull => {
    const ov = st.overrides[m.user_id] ?? { grant: [], deny: [] };
    const template = CATALOG.groups.flatMap((g) => g.items).filter((i) => i.in_role[m.role]).map((i) => i.key);
    return { ...m, custom_permissions: ov.grant.length + ov.deny.length > 0 || m.custom_permissions, hours: st.hours[m.user_id] ?? null, overrides: ov, template, effective: template, open_conversations: o.open ?? 2 };
  };
  const routes: Record<string, Handler> = {
    ...authed(ME_ADMIN),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }), // el menú muestra «Usuarios» a quien administra
    'GET /users': () => ({ body: { items: structuredClone(st.members), invitations: st.invitations } }),
    'GET /users/permissions/catalog': () => ({ body: CATALOG }),
    'GET /queues': () => ({ body: { items: [queue('q1', 'Ventas'), queue('q2', 'Soporte')], limits: { max_queues: 20 } } }),
    'POST /users/invitations': ({ body }) => {
      st.calls.invites.push(body);
      const delivery = o.inviteDelivery ?? 'sent';
      return { status: 201, body: { id: 'i9', email: (body as { email: string }).email, delivery, ...(delivery === 'sent' ? {} : { invite_url: 'https://app.test/accept-invite#token=abc' }) } };
    },
  };
  for (const u of ['u1', 'u2', 'u3']) {
    const find = () => st.members.find((m) => m.user_id === u)!;
    routes[`GET /users/${u}`] = () => ({ body: full(find()) });
    routes[`PATCH /users/${u}`] = ({ body }) => { st.calls.roles.push(body); st.members = st.members.map((m) => (m.user_id === u ? { ...m, role: (body as { role: 'advisor' | 'client_admin' }).role } : m)); return { body: full(find()) }; };
    routes[`PUT /users/${u}/permissions`] = ({ body }) => { st.calls.perms.push(body); st.overrides[u] = body as PermissionOverrides; return { body: full(find()) }; };
    routes[`PUT /users/${u}/departments`] = ({ body }) => { st.calls.depts.push(body); return { body: full(find()) }; };
    routes[`PUT /users/${u}/hours`] = ({ body }) => { st.calls.hours.push(body); st.hours[u] = (body as { days: WeekHours | null }).days; return { body: full(find()) }; };
    for (const kind of ['deactivate', 'remove']) routes[`POST /users/${u}/${kind}`] = ({ body }) => { st.calls.leaves.push({ kind, body }); return { body: { user_id: u, status: kind === 'remove' ? 'removed' : 'deactivated', conversations: { action: 'unassign', moved: 0, to_user_id: null }, collaborations_removed: 0, sessions_revoked: 1 } }; };
    routes[`POST /users/${u}/reactivate`] = () => { st.calls.reactivated.push(u); st.members = st.members.map((m) => (m.user_id === u ? { ...m, status: 'active' } : m)); return { body: full(find()) }; };
    routes[`POST /users/${u}/sessions/revoke`] = () => { st.calls.revoked.push(u); return { body: { user_id: u, sessions_revoked: 2 } }; };
  }
  routes['POST /users/invitations/i1/resend'] = () => { st.calls.resent.push('i1'); return { body: { id: 'i1', email: 'nora@empresa.test', delivery: 'sent' } }; };
  routes['POST /users/invitations/i1/cancel'] = () => { st.calls.cancelled.push('i1'); st.invitations = []; return { body: { id: 'i1', cancelled: true } }; };
  return { st, routes };
}

const openMember = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Abrir a ${name}` }));
  return within(await screen.findByRole('dialog', { name }));
};

describe('permisos (lógica pura)', () => {
  const none: PermissionOverrides = { grant: [], deny: [] };
  const exp = item('contacts.export');
  const viewAll = item('inbox.view_all', { reach: 'all', grantable_to_advisor: false });
  const reply = item('inbox.reply', { in_role: { client_admin: true, advisor: true } });
  const users = item('users.manage', { reach: 'config', grantable_to_advisor: false });

  it('el estado parte de la plantilla del rol y los ajustes lo cambian', () => {
    expect(inTemplate('advisor', exp)).toBe(false);
    expect(isOn('advisor', exp, none)).toBe(false);
    expect(isOn('advisor', exp, { grant: ['contacts.export'], deny: [] })).toBe(true);
    expect(isOn('advisor', reply, { grant: [], deny: ['inbox.reply'] })).toBe(false);
  });
  it('un asesor no puede recibir lo de «toda la empresa» ni lo que no tiene quien concede; lo de la plantilla siempre se puede quitar', () => {
    expect(lockedReason('advisor', viewAll, none)).toMatch(/solo lo suyo/);
    expect(lockedReason('advisor', item('x.y', { holder_can_grant: false }), none)).toMatch(/no tienes/);
    expect(lockedReason('advisor', exp, none)).toBeNull();
    expect(lockedReason('advisor', reply, none)).toBeNull();
    expect(lockedReason('client_admin', users, none)).toMatch(/Protege al equipo/);
    expect(lockedReason('client_admin', item('a.b', { in_role: { client_admin: false, advisor: false } }), none)).toMatch(/No aplica/);
  });
  it('toggle guarda solo lo que se aparta de la plantilla y volver a ella lo limpia', () => {
    const on = toggle('advisor', exp, none, true);
    expect(on).toEqual({ grant: ['contacts.export'], deny: [] });
    expect(toggle('advisor', exp, on, false)).toEqual(none);
    const off = toggle('advisor', reply, none, false);
    expect(off).toEqual({ grant: [], deny: ['inbox.reply'] });
    expect(toggle('advisor', reply, off, true)).toEqual(none);
    expect(sameOverrides({ grant: ['a', 'b'], deny: [] }, { grant: ['b', 'a'], deny: [] })).toBe(true);
  });
});

describe('Usuarios', () => {
  it('lista al equipo con rol, estado, permisos personalizados, departamentos y último acceso; el menú tiene «Usuarios»', async () => {
    mockApi(server({ invitations: [inv()] }).routes);
    renderApp('/users');
    expect(await screen.findByRole('heading', { name: 'Usuarios' })).toBeInTheDocument();
    const list = within(await screen.findByRole('list', { name: 'Personas del equipo' }));
    expect(list.getAllByRole('listitem')).toHaveLength(3);
    const luis = within(list.getByRole('button', { name: 'Abrir a Luis Navas' }));
    expect(luis.getByText('Asesor')).toBeInTheDocument();
    expect(luis.getByText('Permisos personalizados')).toBeInTheDocument();
    expect(luis.getByText('Ventas')).toBeInTheDocument();
    expect(within(list.getByRole('button', { name: 'Abrir a Eva Mora' })).getByText('Desactivado')).toBeInTheDocument();
    expect(within(list.getByRole('button', { name: 'Abrir a Ana Pérez' })).getByText('Administrador')).toBeInTheDocument();
    const pending = within(screen.getByRole('region', { name: 'Invitaciones pendientes' }));
    expect(pending.getByText('nora@empresa.test')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Secciones' })).getByRole('link', { name: 'Usuarios' })).toBeInTheDocument();
  });

  it('busca por nombre o correo y filtra por estado', async () => {
    mockApi(server().routes);
    renderApp('/users');
    await screen.findByRole('list', { name: 'Personas del equipo' });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar usuarios' }), 'luis@');
    expect(screen.getAllByRole('button', { name: /^Abrir a / })).toHaveLength(1);
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Buscar usuarios' }));
    await userEvent.click(screen.getByRole('button', { name: 'Desactivados' }));
    expect(screen.getAllByRole('button', { name: /^Abrir a / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Abrir a Eva Mora']);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar usuarios' }), 'zzz');
    expect(screen.getByText('Nadie coincide con ese filtro.')).toBeInTheDocument();
  });

  it('un asesor (403) ve el motivo y ningún botón de invitar', async () => {
    mockApi({ ...authed(ME_ADVISOR), 'GET /users': () => err(403, 'FORBIDDEN') });
    renderApp('/users');
    expect(await screen.findByText(/Solo el administrador/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invitar persona' })).not.toBeInTheDocument();
  });

  it('invita con rol, departamento y un permiso ajustado; con correo enviado no muestra el enlace', async () => {
    const { st, routes } = server();
    mockApi(routes);
    renderApp('/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Invitar persona' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Invitar al equipo' }));
    await userEvent.type(dlg.getByLabelText(/Correo/), 'nora@empresa.test');
    await userEvent.click(await dlg.findByRole('checkbox', { name: /Ventas/ }));
    await userEvent.click(dlg.getByRole('checkbox', { name: /Ajustar sus permisos/ }));
    await userEvent.click(await dlg.findByRole('switch', { name: 'Exportar contactos' }));
    await userEvent.click(dlg.getByRole('button', { name: 'Enviar invitación' }));
    expect(await screen.findByText(/Enviamos un correo/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Enlace de invitación')).not.toBeInTheDocument();
    expect(st.calls.invites).toEqual([{ email: 'nora@empresa.test', role: 'advisor', permissions: { grant: ['contacts.export'], deny: [] }, queue_ids: ['q1'] }]);
  });

  it('valida el correo antes de enviar y, si el correo no sale, muestra el enlace para copiarlo', async () => {
    const { st, routes } = server({ inviteDelivery: 'unavailable' });
    mockApi(routes);
    renderApp('/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Invitar persona' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Invitar al equipo' }));
    await userEvent.type(dlg.getByLabelText(/Correo/), 'no-es-correo');
    await userEvent.click(dlg.getByRole('button', { name: 'Enviar invitación' }));
    expect(await dlg.findByText('Escribe un correo válido.')).toBeInTheDocument();
    expect(st.calls.invites).toHaveLength(0);
    await userEvent.clear(dlg.getByLabelText(/Correo/));
    await userEvent.type(dlg.getByLabelText(/Correo/), 'a@b.co');
    await userEvent.click(dlg.getByRole('button', { name: 'Enviar invitación' }));
    expect(await screen.findByLabelText('Enlace de invitación')).toHaveValue('https://app.test/accept-invite#token=abc');
  });

  it('el error del servidor (correo ya del equipo) se muestra tal cual', async () => {
    const { routes } = server();
    mockApi({ ...routes, 'POST /users/invitations': () => err(409, 'MEMBER_EXISTS', 'Esa persona ya forma parte de tu equipo.') });
    renderApp('/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Invitar persona' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Invitar al equipo' }));
    await userEvent.type(dlg.getByLabelText(/Correo/), 'luis@empresa.test');
    await userEvent.click(dlg.getByRole('button', { name: 'Enviar invitación' }));
    expect(await dlg.findByText('Esa persona ya forma parte de tu equipo.')).toBeInTheDocument();
  });

  it('reenviar y cancelar una invitación pendiente', async () => {
    const { st, routes } = server({ invitations: [inv()] });
    mockApi(routes);
    renderApp('/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Reenviar la invitación a nora@empresa.test' }));
    expect(await screen.findByText(/Enviamos de nuevo el correo/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Listo' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar la invitación a nora@empresa.test' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Invitaciones pendientes' })).not.toBeInTheDocument());
    expect(st.calls).toMatchObject({ resent: ['i1'], cancelled: ['i1'] });
  });

  it('cambia el rol, los departamentos y el horario de una persona y guarda solo lo que cambió', async () => {
    const { st, routes } = server();
    mockApi(routes);
    renderApp('/users');
    const dlg = await openMember('Luis Navas');
    await userEvent.selectOptions(await dlg.findByLabelText('Rol'), 'client_admin');
    await userEvent.click(dlg.getByRole('checkbox', { name: /Soporte/ }));
    await userEvent.click(dlg.getByRole('checkbox', { name: 'Esta persona tiene su propio horario' }));
    await userEvent.click(dlg.getByRole('button', { name: 'Guardar cambios' }));
    expect(await dlg.findByText('Cambios guardados.')).toBeInTheDocument();
    expect(st.calls.roles).toEqual([{ role: 'client_admin' }]);
    expect(st.calls.depts).toEqual([{ queue_ids: ['q1', 'q2'] }]);
    expect(st.calls.hours).toHaveLength(1);
    const days = (st.calls.hours[0] as { days: WeekHours }).days;
    expect(days.mon).toEqual([['08:30', '18:00']]);
    expect(days.sat).toEqual([]);
  });

  it('sin cambios dice que no había nada que guardar y no llama al servidor', async () => {
    const { st, routes } = server();
    mockApi(routes);
    renderApp('/users');
    const dlg = await openMember('Luis Navas');
    await userEvent.click(await dlg.findByRole('button', { name: 'Guardar cambios' }));
    expect(await dlg.findByText('No había cambios que guardar.')).toBeInTheDocument();
    expect(st.calls.roles.length + st.calls.depts.length + st.calls.hours.length).toBe(0);
  });

  it('un horario mal escrito se corrige antes de enviarlo', async () => {
    const { st, routes } = server();
    mockApi(routes);
    renderApp('/users');
    const dlg = await openMember('Luis Navas');
    await userEvent.click(await dlg.findByRole('checkbox', { name: 'Esta persona tiene su propio horario' }));
    const from = await dlg.findByLabelText('Lunes tramo 1 desde');
    await userEvent.clear(from);
    await userEvent.type(from, '25:99');
    await userEvent.click(dlg.getByRole('button', { name: 'Guardar cambios' }));
    expect(await dlg.findByRole('alert')).toBeInTheDocument();
    expect(st.calls.hours).toHaveLength(0);
  });

  it('permisos: lo que un asesor no puede recibir aparece bloqueado con el motivo; ajustar y guardar manda solo la diferencia; restablecer vuelve a la plantilla', async () => {
    const { st, routes } = server();
    mockApi(routes);
    renderApp('/users');
    const dlg = await openMember('Luis Navas');
    await userEvent.click(dlg.getByRole('tab', { name: 'Permisos' }));
    const viewAll = await dlg.findByRole('switch', { name: 'Ver todas las conversaciones' });
    expect(viewAll).toBeDisabled();
    expect(dlg.getByText(/Un asesor ve solo lo suyo/, { selector: 'span' })).toBeInTheDocument();
    await userEvent.click(dlg.getByRole('switch', { name: 'Exportar contactos' }));
    await userEvent.click(dlg.getByRole('switch', { name: 'Responder conversaciones' })); // la plantilla la trae: se quita
    expect(dlg.getAllByText('Ajustado')).toHaveLength(2);
    await userEvent.click(dlg.getByRole('button', { name: 'Guardar permisos' }));
    expect(await dlg.findByText('Permisos guardados.')).toBeInTheDocument();
    expect(st.calls.perms).toEqual([{ grant: ['contacts.export'], deny: ['inbox.reply'] }]);
    await userEvent.click(dlg.getByRole('button', { name: 'Restablecer a la plantilla del rol' }));
    expect(await dlg.findByText('Volvió a la plantilla del rol.')).toBeInTheDocument();
    expect(st.calls.perms[1]).toEqual({ grant: [], deny: [] });
  });

  it('un administrador no puede perder «Administrar usuarios» (bloqueado)', async () => {
    mockApi(server().routes);
    renderApp('/users');
    const dlg = await openMember('Ana Pérez');
    await userEvent.click(dlg.getByRole('tab', { name: 'Permisos' }));
    expect(await dlg.findByRole('switch', { name: 'Administrar usuarios' })).toBeDisabled();
  });

  it('desactivar exige elegir qué pasa con las conversaciones; transferir exige elegir a quién; no ofrece a la propia persona ni a desactivados', async () => {
    const { st, routes } = server({ open: 3 });
    mockApi(routes);
    renderApp('/users');
    const dlg = await openMember('Luis Navas');
    await userEvent.click(dlg.getByRole('tab', { name: 'Acceso' }));
    await userEvent.click(await dlg.findByRole('button', { name: 'Desactivar' }));
    const leave = within(await screen.findByRole('dialog', { name: 'Desactivar a Luis Navas' }));
    expect(leave.getByText(/Tiene 3 conversaciones abiertas/)).toBeInTheDocument();
    await userEvent.click(leave.getByRole('button', { name: 'Desactivar' }));
    expect(await leave.findByText('Elige qué pasa con sus conversaciones abiertas.')).toBeInTheDocument();
    await userEvent.click(leave.getByRole('radio', { name: /Transferirlas a otra persona/ }));
    await userEvent.click(leave.getByRole('button', { name: 'Desactivar' }));
    expect(await leave.findByText('Elige a quién pasarlas.')).toBeInTheDocument();
    const options = within(leave.getByLabelText('Pasarlas a')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Elige una persona', 'Ana Pérez']);
    await userEvent.selectOptions(leave.getByLabelText('Pasarlas a'), 'u1');
    await userEvent.click(leave.getByRole('button', { name: 'Desactivar' }));
    await waitFor(() => expect(st.calls.leaves).toEqual([{ kind: 'deactivate', body: { conversations: { action: 'transfer', to_user_id: 'u1' } } }]));
  });

  it('quitar del equipo con «dejar sin asignación» y el error del servidor se muestra', async () => {
    const { st, routes } = server();
    mockApi({ ...routes, 'POST /users/u2/remove': () => err(409, 'LAST_ADMIN', 'Es el único administrador de la empresa.') });
    renderApp('/users');
    const dlg = await openMember('Luis Navas');
    await userEvent.click(dlg.getByRole('tab', { name: 'Acceso' }));
    await userEvent.click(await dlg.findByRole('button', { name: 'Quitar del equipo' }));
    const leave = within(await screen.findByRole('dialog', { name: 'Quitar a Luis Navas del equipo' }));
    await userEvent.click(leave.getByRole('radio', { name: /Dejarlas sin asignación/ }));
    await userEvent.click(leave.getByRole('button', { name: 'Quitar del equipo' }));
    expect(await leave.findByText('Es el único administrador de la empresa.')).toBeInTheDocument();
    expect(st.calls.leaves).toHaveLength(0);
  });

  it('en su propia ficha no ofrece desactivarse ni quitarse', async () => {
    mockApi(server().routes);
    renderApp('/users');
    const dlg = await openMember('Ana Pérez');
    await userEvent.click(dlg.getByRole('tab', { name: 'Acceso' }));
    expect(await dlg.findByText(/Esta es tu propia cuenta/)).toBeInTheDocument();
    expect(dlg.queryByRole('button', { name: 'Desactivar' })).not.toBeInTheDocument();
    expect(dlg.queryByRole('button', { name: 'Quitar del equipo' })).not.toBeInTheDocument();
  });

  it('cierra sesiones y reactiva a una persona desactivada', async () => {
    const { st, routes } = server();
    mockApi(routes);
    renderApp('/users');
    const luis = await openMember('Luis Navas');
    await userEvent.click(luis.getByRole('tab', { name: 'Acceso' }));
    await userEvent.click(await luis.findByRole('button', { name: 'Cerrar todas sus sesiones' }));
    expect(await luis.findByText('Se cerraron 2 sesiones.')).toBeInTheDocument();
    await userEvent.click(luis.getByRole('button', { name: 'Cerrar' }));
    const eva = await openMember('Eva Mora');
    await userEvent.click(eva.getByRole('tab', { name: 'Acceso' }));
    await userEvent.click(await eva.findByRole('button', { name: 'Reactivar' }));
    expect(await eva.findByText('Reactivada.')).toBeInTheDocument();
    expect(st.calls).toMatchObject({ revoked: ['u2'], reactivated: ['u3'] });
  });
});
