import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessResetItem, AccessResetResult, Me, TeamMember, TeamMemberFull } from '../src/lib/types';
import { authed, err, ME_ADMIN, ME_AGENCY_IN_CLIENT, ME_ROOT, mockApi, renderApp, resetWorld, type Handler } from './helpers';

// ADR-71 — restablecer el acceso de una persona: el botón de la ficha (solo si se puede), el diálogo y su motivo, y el registro del Súper Admin.

beforeEach(() => { vi.unstubAllGlobals(); resetWorld(); });

const member = (user_id: string, name: string, over: Partial<TeamMember> = {}): TeamMember => ({ user_id, name, email: `${name.split(' ')[0]!.toLowerCase()}@empresa.test`, phone: null, role: 'advisor', status: 'active', joined_at: '2026-10-01T10:00:00.000Z', deactivated_at: null, custom_permissions: false, last_access_at: null, departments: [], ...over });
const PEOPLE = [member('u1', 'Ana Pérez', { role: 'client_admin' }), member('u2', 'Luis Navas'), member('u3', 'Eva Mora')];
const full = (m: TeamMember): TeamMemberFull => ({ ...m, hours: null, overrides: { grant: [], deny: [] }, template: [], effective: [], open_conversations: 0 });
const CATALOG = { roles: [], groups: [] };
const OK: AccessResetResult = { user_id: 'u2', sessions_revoked: 2, email_hint: 'lu***@empresa.test', mail_sent: true, notified: 0 };

interface World { posts: Array<{ id: string; body: unknown }>; allowed: Record<string, boolean | 'forbidden'>; history: unknown[]; result: AccessResetResult | 'bad_password' }
const world = (over: Partial<World> = {}): World => ({ posts: [], allowed: { u2: true, u3: false }, history: [], result: OK, ...over });

function server(w: World, me: Me = ME_ADMIN): Record<string, Handler> {
  const routes: Record<string, Handler> = {
    ...authed(me),
    'GET /custom-fields': () => ({ body: { items: [], access: { manage: true } } }),
    'GET /users': () => ({ body: { items: PEOPLE, invitations: [] } }),
    'GET /users/permissions/catalog': () => ({ body: CATALOG }),
    'GET /users/history': () => ({ body: w.history }),
    'GET /queues': () => ({ body: { items: [], limits: { max_queues: 20 } } }),
  };
  for (const m of PEOPLE) {
    routes[`GET /users/${m.user_id}`] = () => ({ body: full(m) });
    routes[`GET /users/${m.user_id}/reset-access`] = () => {
      const a = w.allowed[m.user_id];
      return a === 'forbidden' ? err(403, 'FORBIDDEN') : { body: { allowed: a === true } };
    };
    routes[`POST /users/${m.user_id}/reset-access`] = ({ body }) => {
      w.posts.push({ id: m.user_id, body });
      return w.result === 'bad_password' ? err(403, 'PASSWORD_INVALID', 'La contraseña no es correcta') : { body: w.result };
    };
  }
  return routes;
}

const openAccess = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Abrir a ${name}` }));
  const dlg = within(await screen.findByRole('dialog', { name }));
  await userEvent.click(dlg.getByRole('tab', { name: 'Acceso' }));
  return dlg;
};

describe('el botón en la ficha de la persona', () => {
  it('aparece solo si el servidor dice que se puede: sí con Luis, no con Eva (aunque esté activa) ni consigo mismo', async () => {
    mockApi(server(world({ allowed: { u1: true, u2: true, u3: false } })));
    renderApp('/users');
    const luis = await openAccess('Luis Navas');
    expect(await luis.findByRole('button', { name: 'Restablecer acceso…' })).toBeInTheDocument();
    await userEvent.click(luis.getByRole('button', { name: 'Cerrar' }));
    const eva = await openAccess('Eva Mora');
    await eva.findByRole('button', { name: 'Cerrar todas sus sesiones' });
    expect(eva.queryByRole('button', { name: 'Restablecer acceso…' })).not.toBeInTheDocument();
    await userEvent.click(eva.getByRole('button', { name: 'Cerrar' }));
    const ana = await openAccess('Ana Pérez');
    await ana.findByText(/Esta es tu propia cuenta/);
    expect(ana.queryByRole('button', { name: 'Restablecer acceso…' })).not.toBeInTheDocument();
  });

  it('sin el permiso (el servidor responde 403) no hay botón', async () => {
    mockApi(server(world({ allowed: { u2: 'forbidden' } })));
    renderApp('/users');
    const luis = await openAccess('Luis Navas');
    await luis.findByRole('button', { name: 'Cerrar todas sus sesiones' });
    await waitFor(() => expect(luis.queryByRole('button', { name: 'Restablecer acceso…' })).not.toBeInTheDocument());
  });
});

describe('el diálogo', () => {
  it('explica qué pasa; para el administrador del cliente el motivo es opcional; pide la contraseña y avisa a dónde salió el correo', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/users');
    const luis = await openAccess('Luis Navas');
    await userEvent.click(await luis.findByRole('button', { name: 'Restablecer acceso…' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Restablecer el acceso de Luis Navas' }));
    expect(dlg.getByText(/Se cierran todas sus sesiones/)).toBeInTheDocument();
    expect(dlg.getByText(/Solo ella o él lo ve: tú no recibes el enlace/)).toBeInTheDocument();
    expect(dlg.getByText(/lu\*\*\*@empresa\.test/)).toBeInTheDocument();
    expect(dlg.queryByText(/Se avisa por correo a los administradores/)).not.toBeInTheDocument();
    // sin contraseña no envía
    await userEvent.click(dlg.getByRole('button', { name: 'Restablecer acceso' }));
    expect(await dlg.findByText('Escribe tu contraseña.')).toBeInTheDocument();
    expect(w.posts).toEqual([]);
    await userEvent.type(dlg.getByLabelText(/Tu contraseña/), 'Clave-Propia-1');
    await userEvent.click(dlg.getByRole('button', { name: 'Restablecer acceso' }));
    expect(await screen.findByRole('dialog', { name: 'Acceso restablecido' })).toBeInTheDocument();
    expect(w.posts).toEqual([{ id: 'u2', body: { current_password: 'Clave-Propia-1' } }]);
    expect(screen.getByText('Cerramos sus 2 sesiones abiertas y enviamos el enlace a lu***@empresa.test.')).toBeInTheDocument();
  });

  it('con un motivo de menos de 10 caracteres no envía; con uno válido lo manda', async () => {
    const w = world();
    mockApi(server(w));
    renderApp('/users');
    const luis = await openAccess('Luis Navas');
    await userEvent.click(await luis.findByRole('button', { name: 'Restablecer acceso…' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Restablecer el acceso de Luis Navas' }));
    await userEvent.type(dlg.getByLabelText(/Motivo/), 'corto');
    await userEvent.type(dlg.getByLabelText(/Tu contraseña/), 'Clave-Propia-1');
    await userEvent.click(dlg.getByRole('button', { name: 'Restablecer acceso' }));
    expect(await dlg.findByText('El motivo debe tener al menos 10 caracteres.')).toBeInTheDocument();
    expect(w.posts).toEqual([]);
    await userEvent.type(dlg.getByLabelText(/Motivo/), ' y más palabras');
    await userEvent.click(dlg.getByRole('button', { name: 'Restablecer acceso' }));
    await screen.findByRole('dialog', { name: 'Acceso restablecido' });
    expect(w.posts[0]!.body).toEqual({ current_password: 'Clave-Propia-1', reason: 'corto y más palabras' });
  });

  it('cuando actúa la agencia el motivo es OBLIGATORIO y se explica el aviso a los administradores', async () => {
    const w = world({ result: { ...OK, notified: 2 } });
    mockApi(server(w, ME_AGENCY_IN_CLIENT));
    renderApp('/users');
    const luis = await openAccess('Luis Navas');
    await userEvent.click(await luis.findByRole('button', { name: 'Restablecer acceso…' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Restablecer el acceso de Luis Navas' }));
    expect(dlg.getByText(/Se avisa por correo a los administradores de la empresa/)).toBeInTheDocument();
    await userEvent.type(dlg.getByLabelText(/Tu contraseña/), 'Clave-Propia-1');
    await userEvent.click(dlg.getByRole('button', { name: 'Restablecer acceso' }));
    expect(await dlg.findByText('Escribe el motivo (al menos 10 caracteres).')).toBeInTheDocument();
    expect(w.posts).toEqual([]);
    await userEvent.type(dlg.getByLabelText(/Motivo/), 'El cliente reportó la cuenta como comprometida');
    await userEvent.click(dlg.getByRole('button', { name: 'Restablecer acceso' }));
    await screen.findByRole('dialog', { name: 'Acceso restablecido' });
    expect(w.posts[0]!.body).toMatchObject({ reason: 'El cliente reportó la cuenta como comprometida' });
    expect(screen.getByText(/Avisamos a 2 administradores de la empresa/)).toBeInTheDocument();
  });

  it('una contraseña equivocada se explica y no cierra el diálogo; si el correo no salió se dice con todas las letras', async () => {
    const w = world({ result: 'bad_password' });
    mockApi(server(w));
    renderApp('/users');
    const luis = await openAccess('Luis Navas');
    await userEvent.click(await luis.findByRole('button', { name: 'Restablecer acceso…' }));
    const dlg = within(await screen.findByRole('dialog', { name: 'Restablecer el acceso de Luis Navas' }));
    await userEvent.type(dlg.getByLabelText(/Tu contraseña/), 'mala');
    await userEvent.click(dlg.getByRole('button', { name: 'Restablecer acceso' }));
    expect(await dlg.findByRole('alert')).toHaveTextContent('La contraseña no es correcta');
    expect(screen.queryByRole('dialog', { name: 'Acceso restablecido' })).not.toBeInTheDocument();
    w.result = { ...OK, mail_sent: false };
    await userEvent.click(dlg.getByRole('button', { name: 'Restablecer acceso' }));
    expect(await screen.findByText(/el correo con el enlace NO salió/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Volver a intentarlo' })).toBeInTheDocument();
  });
});

describe('la historia en la ficha', () => {
  it('muestra los restablecimientos de esa persona: quién, cuándo y el motivo (y nada de otras personas)', async () => {
    const w = world({
      history: [
        { at: '2026-11-15T10:00:00.000Z', kind: 'access_reset', user_id: 'u2', changed_by: 'x', before: null, after: { by: 'agency', reason: 'Cuenta comprometida', sessions_revoked: 1 } },
        { at: '2026-11-14T10:00:00.000Z', kind: 'access_reset', user_id: 'u3', changed_by: 'x', before: null, after: { by: 'client_admin', reason: 'De otra persona', sessions_revoked: 0 } },
        { at: '2026-11-13T10:00:00.000Z', kind: 'sessions_revoked', user_id: 'u2', changed_by: 'x', before: null, after: { revoked: 1 } },
      ],
    });
    mockApi(server(w));
    renderApp('/users');
    const luis = await openAccess('Luis Navas');
    const list = within(await luis.findByRole('region', { name: 'Restablecimientos de acceso' }));
    expect(list.getAllByRole('listitem')).toHaveLength(1);
    expect(list.getByText(/La agencia restableció su acceso\. Motivo: Cuenta comprometida/)).toBeInTheDocument();
    expect(list.queryByText(/De otra persona/)).not.toBeInTheDocument();
  });
});

describe('Plataforma › Accesos › Restablecimientos', () => {
  const item = (over: Partial<AccessResetItem> & { id: string }): AccessResetItem => ({
    actor: { email: 'dave@agencia.test', name: 'Dave Agencia' }, actor_role: 'agency', actor_org: { id: 'ag1', name: 'Agencia Uno' }, organization: { id: 'c1', name: 'Barbería Norte' },
    target: { id: 'u2', email_hint: 'lu***@empresa.test', name: 'Luis Navas' }, reason: 'Cuenta comprometida', sessions_revoked: 2, mail_sent: true, created_at: '2026-11-15T10:00:00.000Z', ...over,
  });

  it('lista quién, a quién, de qué empresa y por qué (correo enmascarado), filtra por quién lo hizo y avisa si el correo no salió', async () => {
    const seen: string[] = [];
    mockApi({
      ...authed(ME_ROOT),
      'GET /platform/access-sessions': () => ({ body: { items: [], next_cursor: null } }),
      'GET /platform/access-resets': ({ query }) => {
        seen.push(query.get('actor_role') ?? '');
        const all = [item({ id: 'r1' }), item({ id: 'r2', actor: { email: 'root@plataforma.test', name: null }, actor_role: 'super_admin', actor_org: null, organization: null, target: { id: 'u9', email_hint: 'hu***@ab.test', name: 'Hugo Sosa' }, reason: null, sessions_revoked: 1, mail_sent: false })];
        return { body: { items: query.get('actor_role') === 'agency' ? [all[0]!] : all, next_cursor: null } };
      },
    });
    renderApp('/platform/access');
    await userEvent.click(await screen.findByRole('tab', { name: 'Restablecimientos' }));
    const rows = within(await screen.findByRole('list', { name: 'Restablecimientos de acceso' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Dave Agencia')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Agencia · Agencia Uno/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/lu\*\*\*@empresa\.test · Barbería Norte/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Motivo: Cuenta comprometida')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Correo enviado')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Sin motivo')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('El correo no salió')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Varias empresas \/ plataforma/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Quién lo hizo'), 'agency');
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Restablecimientos de acceso' })).getAllByRole('listitem')).toHaveLength(1));
    expect(seen).toContain('agency');
  });
});
