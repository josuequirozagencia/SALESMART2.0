// M10.3 — Usuarios del equipo: roles, permisos por persona, invitaciones, desactivar y quitar (ADR-56 B3). Rutas cubiertas (el registro de endpoints exige que este archivo las escriba tal cual):
//   GET /v1/users
//   GET /v1/users/permissions/catalog
//   GET /v1/users/history
//   POST /v1/users/invitations
//   POST /v1/users/invitations/:id/resend
//   POST /v1/users/invitations/:id/cancel
//   GET /v1/users/:userId
//   PATCH /v1/users/:userId
//   PUT /v1/users/:userId/permissions
//   PUT /v1/users/:userId/departments
//   PUT /v1/users/:userId/hours
//   POST /v1/users/:userId/deactivate
//   POST /v1/users/:userId/remove
//   POST /v1/users/:userId/reactivate
//   POST /v1/users/:userId/sessions/revoke
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { MAIL_PROVIDER, MemoryMailProvider } from '../../src/modules/auth/signup';
import { ChannelsModule } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { TeamModule } from '../../src/modules/team';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, InboxModule, TeamModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const NEW_PW = 'Nueva-Clave-2026';
const NOBODY = '11111111-1111-4111-8111-111111111111';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  frank: 'f1000000-0000-4000-8000-0000000000f2', // segundo client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  eve: 'e0000000-0000-4000-8000-0000000000e5', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  gina: 'a9000000-0000-4000-8000-0000000000a9', // asesora de B
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let mail: MemoryMailProvider;
let T: Record<'alice' | 'frank' | 'carol' | 'eve' | 'bob' | 'gina' | 'root', string>;
const saved = { ...process.env };

async function start(): Promise<void> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'INVITATION_RESEND_COOLDOWN_SECONDS', 'INVITATION_ATTEMPT_IP_MAX_PER_HOUR']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', INVITATION_ATTEMPT_IP_MAX_PER_HOUR: '500' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
  mail = app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE user_hours, holidays, business_hours, messages, conversations, conversation_participants, response_timers, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_phones, contacts, audit_logs, member_permissions, member_history, invitations, access_sessions, sessions, auth_throttle, signup_attempts, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.frank, 'frank@a.test', 'Francisco Paz'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.gina, 'gina@b.test', 'Gina Ríos'], [IDS.root, 'root@plat.test', 'Root']];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.frank, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.gina, ORG_B, 'advisor'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string, password = PW): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};
const tokenOf = (url: string): string => new URL(url).hash.replace(/^#token=/, '');

interface Member { user_id: string; name: string; email: string; role: string; status: string; custom_permissions: boolean; departments: Array<{ id: string; name: string }>; deactivated_at: string | null }
type Week = Record<string, Array<[string, string]>>;
interface Full extends Member { hours: Week | null; overrides: { grant: string[]; deny: string[] }; template: string[]; effective: string[]; open_conversations: number }
interface TeamList { items: Member[]; invitations: Array<{ id: string; email: string; role: string; expired: boolean; setup: { grant: string[]; deny: string[]; queue_ids: string[] } }> }
interface Leave { user_id: string; status: string; conversations: { action: string; moved: number; to_user_id: string | null }; collaborations_removed: number; sessions_revoked: number }
const list = async (t: string): Promise<TeamList> => ok<TeamList>(await call('GET', '/users', t));
const one = async (t: string, id: string): Promise<Full> => ok<Full>(await call('GET', `/users/${id}`, t));
const queue = async (t: string, name: string): Promise<string> => (await ok<{ id: string }>(await call('POST', '/queues', t, { name }), 201)).id;
const exportAll = (t: string) => call('POST', '/contacts/export', t, { scope: 'all' });
const leaveBody = (action: 'transfer' | 'unassign', to?: string) => ({ conversations: { action, ...(to ? { to_user_id: to } : {}) } });

let seq = 0;
/** Una conversación abierta de `owner` con su contacto (dueño: el mismo) y un mensaje del cliente. */
async function mkConv(owner: string | null, o: { org?: string; status?: string } = {}): Promise<{ id: string; contact: string }> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const channel = (await admin.query(`SELECT id FROM channel_accounts WHERE organization_id = $1 AND deleted_at IS NULL LIMIT 1`, [org])).rows[0]?.id as string;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  const status = o.status ?? (owner ? 'working' : 'unassigned');
  const id = (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, now(), now(), 1, $7) RETURNING id`,
      [org, contact, channel, status, owner, owner ? new Date() : null, `59398500${String(seq).padStart(4, '0')}`],
    )
  ).rows[0].id as string;
  await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, external_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'in', 'contact', 'text', 'Hola', 'received', now())`, [org, id, channel, `wamid.T${seq}`]);
  return { id, contact };
}
const convRow = async (id: string) => (await admin.query(`SELECT status, owner_id, assigned_at FROM conversations WHERE id = $1`, [id])).rows[0] as { status: string; owner_id: string | null; assigned_at: Date | null };
const contactOwner = async (id: string): Promise<string | null> => (await admin.query(`SELECT owner_id FROM contacts WHERE id = $1`, [id])).rows[0].owner_id as string | null;
const memberRow = async (user: string, org = ORG_A) => (await admin.query(`SELECT role, revoked_at, revoked_reason FROM organization_members WHERE user_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT 1`, [user, org])).rows[0] as { role: string; revoked_at: Date | null; revoked_reason: string | null };
const history = async (org = ORG_A) => (await admin.query(`SELECT kind, user_id FROM member_history WHERE organization_id = $1 ORDER BY created_at, id`, [org])).rows as Array<{ kind: string; user_id: string | null }>;
const audits = async (entityId: string) => (await admin.query(`SELECT field, old_value, new_value FROM audit_logs WHERE entity_type = 'user' AND entity_id = $1 ORDER BY id`, [entityId])).rows as Array<{ field: string; old_value: unknown; new_value: unknown }>;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  await start();
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  mail.inviteOutbox.length = 0;
  app.get(OrgDirectoryService).invalidate();
  T = { alice: await login('alice@a.test'), frank: await login('frank@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test'), gina: await login('gina@b.test'), root: await login('root@plat.test') };
  // Un número conectado para la empresa A (las conversaciones de prueba lo necesitan)
  await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'meta_cloud', 'Ventas')`, [ORG_A]);
  await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'meta_cloud', 'Ventas B')`, [ORG_B]);
});

describe('acceso', () => {
  it('sin sesión 401; la plataforma 403; el asesor 403 en TODAS las rutas (users.manage no se otorga a un asesor)', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/users'], ['GET', '/users/permissions/catalog'], ['GET', '/users/history'],
      ['POST', '/users/invitations', { email: 'x@y.test', role: 'advisor' }], ['POST', `/users/invitations/${NOBODY}/resend`], ['POST', `/users/invitations/${NOBODY}/cancel`],
      ['GET', `/users/${IDS.eve}`], ['PATCH', `/users/${IDS.eve}`, { role: 'client_admin' }], ['PUT', `/users/${IDS.eve}/permissions`, { grant: [], deny: [] }], ['PUT', `/users/${IDS.eve}/departments`, { queue_ids: [] }], ['PUT', `/users/${IDS.eve}/hours`, { days: null }],
      ['POST', `/users/${IDS.eve}/deactivate`, leaveBody('unassign')], ['POST', `/users/${IDS.eve}/remove`, leaveBody('unassign')], ['POST', `/users/${IDS.eve}/reactivate`], ['POST', `/users/${IDS.eve}/sessions/revoke`],
    ];
    for (const [m, p, body] of routes) {
      expect((await call(m, p, undefined, body)).status, `${m} ${p} sin sesión`).toBe(401);
      expect((await call(m, p, T.root, body)).status, `${m} ${p} plataforma`).toBe(403);
      expect((await call(m, p, T.carol, body)).status, `${m} ${p} asesora`).toBe(403);
    }
    // nada cambió
    expect((await memberRow(IDS.eve)).revoked_at).toBeNull();
  });

  it('incluso con un ajuste, un asesor no puede administrar usuarios: users.manage no se concede (400) y no entra por la puerta de atrás', async () => {
    const r = await call('PUT', `/users/${IDS.carol}/permissions`, T.alice, { grant: ['users.manage'], deny: [] });
    expect(r.status).toBe(400);
    expect((await call('GET', '/users', T.carol)).status).toBe(403);
  });
});

describe('lista, detalle y catálogo', () => {
  it('la lista trae a las personas de la empresa con su rol y estado, y las invitaciones pendientes; nada de otra empresa', async () => {
    const l = await list(T.alice);
    expect(l.items.map((m) => [m.name, m.role, m.status])).toEqual([['Alicia Torres', 'client_admin', 'active'], ['Carolina Vera', 'advisor', 'active'], ['Eva Mora', 'advisor', 'active'], ['Francisco Paz', 'client_admin', 'active']]);
    expect(l.invitations).toEqual([]);
    expect(JSON.stringify(l)).not.toMatch(/Beto|Gina|bob@b|gina@b/);
    expect((await list(T.bob)).items.map((m) => m.name)).toEqual(['Beto Luna', 'Gina Ríos']);
  });

  it('el detalle trae la plantilla del rol, los ajustes, lo efectivo y cuántas conversaciones abiertas tiene', async () => {
    await mkConv(IDS.carol);
    await mkConv(IDS.carol, { status: 'closed' }); // las finalizadas no cuentan
    const d = await one(T.alice, IDS.carol);
    expect(d).toMatchObject({ role: 'advisor', status: 'active', custom_permissions: false, open_conversations: 1, overrides: { grant: [], deny: [] } });
    expect(d.template).toContain('inbox.reply');
    expect(d.effective.sort()).toEqual([...d.template].sort());
    expect(d.template).not.toContain('contacts.view_all');
  });

  it('A↔B: una persona de otra empresa es 404 en todas las rutas con :userId y la lista de B no la muestra', async () => {
    const id = IDS.gina; // de B, vista por el administrador de A
    for (const [m, p, body] of [['GET', `/users/${id}`], ['PATCH', `/users/${id}`, { role: 'client_admin' }], ['PUT', `/users/${id}/permissions`, { grant: [], deny: [] }], ['PUT', `/users/${id}/departments`, { queue_ids: [] }], ['PUT', `/users/${id}/hours`, { days: null }], ['POST', `/users/${id}/deactivate`, leaveBody('unassign')], ['POST', `/users/${id}/remove`, leaveBody('unassign')], ['POST', `/users/${id}/reactivate`], ['POST', `/users/${id}/sessions/revoke`]] as Array<[string, string, unknown?]>) {
      expect((await call(m, p, T.alice, body)).status, `${m} ${p}`).toBe(404);
    }
    expect((await memberRow(IDS.gina, ORG_B)).revoked_at).toBeNull();
    expect((await call('GET', `/users/${NOBODY}`, T.alice)).status).toBe(404);
  });

  it('el catálogo agrupa los permisos en español, dice cuáles trae cada rol y que los de «toda la empresa» no se conceden a un asesor', async () => {
    const c = await ok<{ roles: Array<{ id: string; label: string }>; groups: Array<{ id: string; label: string; items: Array<{ key: string; label: string; reach: string; in_role: { client_admin: boolean; advisor: boolean }; grantable_to_advisor: boolean; holder_can_grant: boolean }> }> }>(await call('GET', '/users/permissions/catalog', T.alice));
    expect(c.roles.map((r) => r.label)).toEqual(['Administrador', 'Asesor']);
    const items = c.groups.flatMap((g) => g.items);
    expect(c.groups.map((g) => g.label)).toContain('Conversaciones');
    for (const it of items.filter((x) => x.reach === 'all')) expect(it.grantable_to_advisor, it.key).toBe(false);
    const exp = items.find((x) => x.key === 'contacts.export')!;
    expect(exp).toMatchObject({ in_role: { client_admin: true, advisor: false }, grantable_to_advisor: true, holder_can_grant: true });
    expect(items.find((x) => x.key === 'users.manage')!.grantable_to_advisor).toBe(false);
    expect(items.every((x) => x.label.length > 3)).toBe(true);
  });
});

describe('cambiar el rol', () => {
  it('administrador ↔ asesor; los ajustes se reinician; mismo rol 409; queda en la historia y la auditoría', async () => {
    await ok(await call('PUT', `/users/${IDS.carol}/permissions`, T.alice, { grant: ['contacts.export'], deny: [] }));
    expect((await one(T.alice, IDS.carol)).custom_permissions).toBe(true);
    const up = await ok<Full>(await call('PATCH', `/users/${IDS.carol}`, T.alice, { role: 'client_admin' }));
    expect(up).toMatchObject({ role: 'client_admin', custom_permissions: false });
    expect(up.effective).toContain('users.manage');
    expect(await code(await call('PATCH', `/users/${IDS.carol}`, T.alice, { role: 'client_admin' }))).toBe('ROLE_UNCHANGED');
    expect((await history()).map((h) => h.kind)).toEqual(['permissions_changed', 'role_changed']);
    expect((await audits(IDS.carol)).map((a) => a.field)).toEqual(['permissions', 'role']);
    // y vuelve a asesora: pierde lo de administrador al instante (su sesión sigue, sus permisos cambian en la petición siguiente)
    await ok(await call('PATCH', `/users/${IDS.carol}`, T.alice, { role: 'advisor' }));
    expect((await call('GET', '/users', T.carol)).status).toBe(403);
  });

  it('el último administrador no baja de rol (409 LAST_ADMIN); con otro administrador, sí', async () => {
    await ok(await call('POST', `/users/${IDS.frank}/deactivate`, T.alice, leaveBody('unassign')));
    const r = await call('PATCH', `/users/${IDS.alice}`, T.alice, { role: 'advisor' });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('LAST_ADMIN');
    expect((await memberRow(IDS.alice)).role).toBe('client_admin');
    // con un segundo administrador activo, cada uno puede bajarse (frank vuelve y alice se baja a sí misma)
    await ok(await call('POST', `/users/${IDS.frank}/reactivate`, T.alice));
    const fresh = await login('frank@a.test');
    await ok(await call('PATCH', `/users/${IDS.alice}`, fresh, { role: 'advisor' }));
    expect((await memberRow(IDS.alice)).role).toBe('advisor');
  });

  it('valida el cuerpo: rol desconocido o campos de más dan 400', async () => {
    for (const body of [{ role: 'super_admin' }, { role: 'agency' }, {}, { role: 'advisor', x: 1 }]) expect((await call('PATCH', `/users/${IDS.carol}`, T.alice, body)).status, JSON.stringify(body)).toBe(400);
  });
});

describe('permisos por persona', () => {
  it('conceder una función rige desde la petición siguiente; quitarla también; los ajustes se reemplazan, no se suman', async () => {
    expect((await exportAll(T.carol)).status).toBe(403); // la asesora no exporta por defecto
    const g = await ok<Full>(await call('PUT', `/users/${IDS.carol}/permissions`, T.alice, { grant: ['contacts.export'], deny: [] }));
    expect(g).toMatchObject({ custom_permissions: true, overrides: { grant: ['contacts.export'], deny: [] } });
    expect(g.effective).toContain('contacts.export');
    expect((await exportAll(T.carol)).status).toBe(200); // mismo token, efecto inmediato
    // reemplaza: ahora le quita crear ventas y ya no exporta
    const d = await ok<Full>(await call('PUT', `/users/${IDS.carol}/permissions`, T.alice, { grant: [], deny: ['sales.create'] }));
    expect(d.overrides).toEqual({ grant: [], deny: ['sales.create'] });
    expect(d.effective).not.toContain('sales.create');
    expect((await exportAll(T.carol)).status).toBe(403);
    // limpiar = volver a la plantilla
    const clean = await ok<Full>(await call('PUT', `/users/${IDS.carol}/permissions`, T.alice, { grant: [], deny: [] }));
    expect(clean).toMatchObject({ custom_permissions: false });
    expect((await list(T.alice)).items.find((m) => m.user_id === IDS.carol)!.custom_permissions).toBe(false);
  });

  it('REGLA INVIOLABLE: a un asesor no se le concede nada de alcance «toda la empresa» (400 con el motivo); lo demás del envío no se aplica', async () => {
    for (const k of ['contacts.view_all', 'inbox.view_all', 'sales.view_all', 'appointments.view_all', 'analytics.view_all']) {
      const r = await call('PUT', `/users/${IDS.carol}/permissions`, T.alice, { grant: ['contacts.export', k], deny: [] });
      expect(r.status, k).toBe(400);
      const body = await json<{ error: { details: Array<{ path: string; code: string; message: string }> } }>(r);
      expect(body.error.details[0]).toMatchObject({ path: `permissions.${k}`, code: 'not_grantable' });
      expect(body.error.details[0]!.message).toMatch(/solo lo suyo/);
    }
    expect((await one(T.alice, IDS.carol)).overrides).toEqual({ grant: [], deny: [] }); // nada de lo enviado quedó guardado
  });

  it('rechaza lo inexistente, lo repetido, lo de plataforma y el permiso que protege al equipo; a un administrador no se le concede, solo se le quita', async () => {
    for (const body of [{ grant: ['no.existe'], deny: [] }, { grant: ['contacts.export'], deny: ['contacts.export'] }, { grant: ['platform.plans.manage'], deny: [] }, { grant: [], deny: ['users.manage'] }, { grant: ['billing.manage'], deny: [] }, { grant: [], deny: [], extra: 1 }]) {
      expect((await call('PUT', `/users/${IDS.carol}/permissions`, T.alice, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('PUT', `/users/${IDS.frank}/permissions`, T.alice, { grant: ['contacts.export'], deny: [] })).status).toBe(400);
    const r = await ok<Full>(await call('PUT', `/users/${IDS.frank}/permissions`, T.alice, { grant: [], deny: ['contacts.delete'] }));
    expect(r.effective).not.toContain('contacts.delete');
    expect(r.effective).toContain('users.manage');
    // el último permiso que protege al equipo no se quita ni a otro administrador
    expect((await call('PUT', `/users/${IDS.frank}/permissions`, T.alice, { grant: [], deny: ['users.manage'] })).status).toBe(400);
  });

  it('queda en la historia (atómica) y en la auditoría de la empresa con lo de antes y lo de ahora', async () => {
    await ok(await call('PUT', `/users/${IDS.carol}/permissions`, T.alice, { grant: ['contacts.export'], deny: [] }));
    await ok(await call('PUT', `/users/${IDS.carol}/permissions`, T.alice, { grant: ['contacts.export', 'channels.manage'], deny: ['sales.create'] }));
    const h = (await admin.query(`SELECT before, after, changed_by FROM member_history WHERE kind = 'permissions_changed' AND user_id = $1 ORDER BY created_at, id`, [IDS.carol])).rows;
    expect(h).toHaveLength(2);
    expect(h[1]).toMatchObject({ before: { grant: ['contacts.export'], deny: [] }, after: { grant: ['contacts.export', 'channels.manage'], deny: ['sales.create'] }, changed_by: IDS.alice });
    // reemplazar marca los anteriores como revocados (sin DELETE en identidad): quedan 3 vigentes y 1 revocado
    const rows = (await admin.query(`SELECT p.revoked_at IS NULL AS active, count(*)::int AS n FROM member_permissions p JOIN organization_members m ON m.id = p.membership_id WHERE m.user_id = $1 GROUP BY 1`, [IDS.carol])).rows as Array<{ active: boolean; n: number }>;
    expect(Object.fromEntries(rows.map((r) => [String(r.active), r.n]))).toEqual({ true: 3, false: 1 });
    const a = await audits(IDS.carol);
    expect(a).toHaveLength(2);
    expect(a[1]).toMatchObject({ field: 'permissions', new_value: { grant: ['contacts.export', 'channels.manage'], deny: ['sales.create'] } });
  });

  it('un dato indebido en la tabla (grant fuera del techo) no concede nada: la resolución lo recorta', async () => {
    const m = (await admin.query(`SELECT id FROM organization_members WHERE user_id = $1 AND organization_id = $2`, [IDS.carol, ORG_A])).rows[0].id as string;
    await admin.query(`INSERT INTO member_permissions(id, membership_id, permission_key, effect) VALUES (gen_random_uuid(), $1, 'contacts.view_all', 'grant'), (gen_random_uuid(), $1, 'users.manage', 'grant')`, [m]);
    expect((await call('GET', '/users', T.carol)).status).toBe(403);
    expect((await one(T.alice, IDS.carol)).effective).not.toContain('contacts.view_all');
  });
});

describe('departamentos de la persona', () => {
  it('reemplaza los departamentos; la lista y el detalle los muestran; uno de otra empresa o inexistente da 400', async () => {
    const q1 = await queue(T.alice, 'Ventas');
    const q2 = await queue(T.alice, 'Soporte');
    const r = await ok<Full>(await call('PUT', `/users/${IDS.carol}/departments`, T.alice, { queue_ids: [q1, q2] }));
    expect(r.departments.map((d) => d.name).sort()).toEqual(['Soporte', 'Ventas']);
    const r2 = await ok<Full>(await call('PUT', `/users/${IDS.carol}/departments`, T.alice, { queue_ids: [q2] }));
    expect(r2.departments.map((d) => d.name)).toEqual(['Soporte']);
    expect((await list(T.alice)).items.find((m) => m.user_id === IDS.carol)!.departments.map((d) => d.name)).toEqual(['Soporte']);
    const qb = await queue(T.bob, 'De B');
    expect((await call('PUT', `/users/${IDS.carol}/departments`, T.alice, { queue_ids: [qb] })).status).toBe(400);
    expect((await call('PUT', `/users/${IDS.carol}/departments`, T.alice, { queue_ids: [NOBODY] })).status).toBe(400);
    expect((await call('PUT', `/users/${IDS.carol}/departments`, T.alice, { queue_ids: [q1, q1] })).status).toBe(400);
    expect((await history()).filter((h) => h.kind === 'queues_changed')).toHaveLength(2);
    // vaciar la saca de todos
    expect((await ok<Full>(await call('PUT', `/users/${IDS.carol}/departments`, T.alice, { queue_ids: [] }))).departments).toEqual([]);
  });
});

describe('horario laboral por persona', () => {
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const weekOf = (a: string, b: string): Week => Object.fromEntries(DAYS.map((d) => [d, [[a, b]]]));
  const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  /** Una ventana de una hora de la que AHORA (hora de la empresa) queda fuera, sin depender de la hora a la que corra la prueba. */
  const closedNowWeek = (): Week => {
    const t = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Guayaquil', hour12: false, hour: '2-digit', minute: '2-digit' }).split(':').map(Number) as [number, number];
    const start = t[0] * 60 + t[1] >= 600 ? 0 : 1000;
    return weekOf(hhmm(start), hhmm(start + 60));
  };
  const put = (t: string, id: string, days: Week | null) => call('PUT', `/users/${id}/hours`, t, { days });
  const sequence = async (qid: string): Promise<string[]> => (await ok<{ sequence: Array<{ user_id: string }> }>(await call('POST', `/queues/${qid}/simulate`, T.alice, { count: 4 }))).sequence.map((x) => x.user_id);

  it('guarda el horario, lo muestra en el detalle y se puede cambiar y quitar; queda en la auditoría', async () => {
    expect((await one(T.alice, IDS.carol)).hours).toBeNull();
    const week = weekOf('08:00', '17:00');
    const r = await ok<Full>(await put(T.alice, IDS.carol, week));
    expect(r.hours).toEqual(week);
    expect((await one(T.alice, IDS.carol)).hours).toEqual(week);
    const week2 = { ...week, sat: [['09:00', '12:00']] as Array<[string, string]>, sun: [] };
    expect((await ok<Full>(await put(T.alice, IDS.carol, week2))).hours).toEqual(week2);
    expect((await ok<Full>(await put(T.alice, IDS.carol, null))).hours).toBeNull();
    expect((await ok<Full>(await put(T.alice, IDS.carol, null))).hours).toBeNull(); // quitarlo dos veces no falla
    const hist = (await admin.query(`SELECT old_value, new_value FROM audit_logs WHERE entity_type = 'user_hours' AND entity_id = $1 ORDER BY id`, [IDS.carol])).rows;
    expect(hist).toHaveLength(3); // alta, cambio y quitar
    expect(hist[2]).toMatchObject({ new_value: null });
    // quitar lo desactiva: la fila sigue (sin DELETE) y se reactiva al guardar otro
    expect((await admin.query(`SELECT active FROM user_hours WHERE user_id = $1`, [IDS.carol])).rows).toEqual([{ active: false }]);
    await ok(await put(T.alice, IDS.carol, week));
    expect((await admin.query(`SELECT active FROM user_hours WHERE user_id = $1`, [IDS.carol])).rows).toEqual([{ active: true }]);
  });

  it('valida: semana sin ningún día abierto, horas mal escritas, tramos que se cruzan o claves de más dan 400', async () => {
    for (const days of [{}, { mon: [] }, { mon: [['25:00', '26:00']] }, { mon: [['10:00', '09:00']] }, { mon: [['08:00', '12:00'], ['11:00', '14:00']] }, { lun: [['08:00', '12:00']] }]) {
      expect((await call('PUT', `/users/${IDS.carol}/hours`, T.alice, { days })).status, JSON.stringify(days)).toBe(400);
    }
    expect((await call('PUT', `/users/${IDS.carol}/hours`, T.alice, {})).status).toBe(400);
    expect((await call('PUT', `/users/${IDS.carol}/hours`, T.alice, { days: null, extra: 1 })).status).toBe(400);
    expect((await one(T.alice, IDS.carol)).hours).toBeNull();
  });

  it('a una persona desactivada no se le cambia el horario (409) y no se guarda nada', async () => {
    await ok(await call('POST', `/users/${IDS.eve}/deactivate`, T.alice, leaveBody('unassign')));
    const r = await put(T.alice, IDS.eve, weekOf('08:00', '17:00'));
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('MEMBER_INACTIVE');
    expect(Number((await admin.query(`SELECT count(*) FROM user_hours`)).rows[0].count)).toBe(0);
  });

  it('EFECTO EN EL REPARTO: fuera de su horario la persona no recibe asignaciones nuevas; sin horario o dentro de él, sí', async () => {
    const q = await queue(T.alice, 'Ventas');
    await ok(await call('PUT', `/queues/${q}/members`, T.alice, { members: [{ user_id: IDS.carol, active: true, weight: 1 }, { user_id: IDS.eve, active: true, weight: 1 }] }));
    expect(new Set(await sequence(q))).toEqual(new Set([IDS.carol, IDS.eve]));
    await ok(await put(T.alice, IDS.carol, closedNowWeek()));
    expect(new Set(await sequence(q))).toEqual(new Set([IDS.eve])); // carol está fuera de su horario
    await ok(await put(T.alice, IDS.carol, weekOf('00:00', '23:59')));
    expect(new Set(await sequence(q))).toEqual(new Set([IDS.carol, IDS.eve])); // dentro de su horario
    await ok(await put(T.alice, IDS.carol, closedNowWeek()));
    await ok(await put(T.alice, IDS.carol, null)); // quitar el horario la deja disponible siempre
    expect(new Set(await sequence(q))).toEqual(new Set([IDS.carol, IDS.eve]));
  });

  it('un feriado de la empresa también cierra el horario de la persona', async () => {
    const q = await queue(T.alice, 'Ventas');
    await ok(await call('PUT', `/queues/${q}/members`, T.alice, { members: [{ user_id: IDS.carol, active: true, weight: 1 }, { user_id: IDS.eve, active: true, weight: 1 }] }));
    await ok(await put(T.alice, IDS.carol, weekOf('00:00', '23:59')));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
    await ok(await call('POST', '/sla/holidays', T.alice, { date: today, name: 'Feriado de prueba', yearly: false }), 201);
    expect(new Set(await sequence(q))).toEqual(new Set([IDS.eve]));
  });

  it('A↔B: el horario de una persona de A no se ve ni cuenta en B', async () => {
    await ok(await put(T.alice, IDS.carol, weekOf('08:00', '17:00')));
    expect((await put(T.alice, IDS.gina, weekOf('08:00', '17:00'))).status).toBe(404);
    expect((await put(T.bob, IDS.carol, weekOf('08:00', '17:00'))).status).toBe(404);
    expect(Number((await admin.query(`SELECT count(*) FROM user_hours WHERE organization_id = $1`, [ORG_B])).rows[0].count)).toBe(0);
  });
});

describe('invitar al equipo', () => {
  const invite = (t: string, body: Record<string, unknown>) => call('POST', '/users/invitations', t, body);
  const accept = (token: string, body: Record<string, unknown> = {}) => call('POST', '/auth/invitations/accept', undefined, { token, password: NEW_PW, full_name: 'Nora Díaz', phone: '+593987654321', ...body });

  it('invita a un asesor con ajustes y departamentos: el enlace NO viaja en la respuesta; al aceptar entra con exactamente eso y puede usar lo concedido', async () => {
    const q = await queue(T.alice, 'Ventas');
    const r = await ok<{ id: string; email: string; delivery: string; invite_url?: string }>(await invite(T.alice, { email: 'Nora@A.test ', role: 'advisor', permissions: { grant: ['contacts.export'], deny: [] }, queue_ids: [q] }), 201);
    expect(r).toMatchObject({ email: 'nora@a.test', delivery: 'sent' });
    expect(r.invite_url).toBeUndefined();
    const pending = (await list(T.alice)).invitations;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ email: 'nora@a.test', role: 'advisor', expired: false, setup: { grant: ['contacts.export'], deny: [], queue_ids: [q] } });
    const url = mail.lastInvitation('nora@a.test')!.inviteUrl;
    expect(mail.lastInvitation('nora@a.test')!.organizationName).toBe('Barbería Norte');

    await ok(await accept(tokenOf(url)));
    const nora = (await admin.query(`SELECT id FROM users WHERE email = 'nora@a.test'`)).rows[0].id as string;
    expect(await memberRow(nora)).toMatchObject({ role: 'advisor', revoked_at: null });
    const d = await one(T.alice, nora);
    expect(d).toMatchObject({ name: 'Nora Díaz', role: 'advisor', custom_permissions: true, overrides: { grant: ['contacts.export'], deny: [] } });
    expect(d.departments.map((x) => x.name)).toEqual(['Ventas']);
    expect((await list(T.alice)).invitations).toEqual([]);
    const norasToken = await login('nora@a.test', NEW_PW);
    expect((await exportAll(norasToken)).status).toBe(200); // lo concedido al invitar ya funciona
    expect((await call('GET', '/users', norasToken)).status).toBe(403); // y sigue siendo asesora
    expect((await history()).map((h) => h.kind)).toEqual(['invited', 'invited']); // enviada y aceptada
  });

  it('si el correo no sale, el enlace vuelve solo al administrador que invita (y nunca con «sent»)', async () => {
    mail.inviteOutbox.length = 0;
    const prev = mail.available;
    (mail as unknown as { available: boolean }).available = false;
    try {
      const r = await ok<{ delivery: string; invite_url?: string }>(await invite(T.alice, { email: 'sinCorreo@a.test', role: 'advisor' }), 201);
      expect(r.delivery).toBe('unavailable');
      expect(r.invite_url).toMatch(/^https:\/\/app\.ejemplo\.test\/accept-invite#token=/);
    } finally {
      (mail as unknown as { available: boolean }).available = prev;
    }
  });

  it('no deja conceder lo que no cabe en el rol (400) ni departamentos de otra empresa; un correo que ya es del equipo es 409; el de un Súper Admin se rechaza', async () => {
    expect((await invite(T.alice, { email: 'x@a.test', role: 'advisor', permissions: { grant: ['contacts.view_all'], deny: [] } })).status).toBe(400);
    expect((await invite(T.alice, { email: 'x@a.test', role: 'advisor', queue_ids: [await queue(T.bob, 'De B')] })).status).toBe(400);
    const dup = await invite(T.alice, { email: 'carol@a.test', role: 'advisor' });
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe('MEMBER_EXISTS');
    const sa = await invite(T.alice, { email: 'root@plat.test', role: 'advisor' });
    expect(sa.status).toBe(400);
    expect(await code(sa)).toBe('INVITE_NOT_ALLOWED');
    for (const body of [{ email: 'no-es-correo', role: 'advisor' }, { email: 'a@b.test', role: 'agency' }, { email: 'a@b.test', role: 'advisor', extra: 1 }, { role: 'advisor' }]) expect((await invite(T.alice, body)).status, JSON.stringify(body)).toBe(400);
    expect(mail.inviteOutbox.length).toBe(0); // ninguna de las rechazadas mandó correo
  });

  it('una cuenta que ya existe (otra empresa) NO se duplica: confirma con su contraseña y se añade la membresía', async () => {
    await ok(await invite(T.alice, { email: 'gina@b.test', role: 'advisor' }), 201);
    const url = mail.lastInvitation('gina@b.test')!.inviteUrl;
    const wrong = await accept(tokenOf(url), { password: 'No-Es-Esta-123' });
    expect(wrong.status).toBe(400);
    await ok(await accept(tokenOf(url), { password: PW }));
    expect(Number((await admin.query(`SELECT count(*) FROM users WHERE email = 'gina@b.test'`)).rows[0].count)).toBe(1);
    expect(await memberRow(IDS.gina, ORG_A)).toMatchObject({ role: 'advisor', revoked_at: null });
    expect((await memberRow(IDS.gina, ORG_B)).revoked_at).toBeNull(); // sigue en la otra
  });

  it('reenviar cambia el token (el enlace anterior deja de valer) y respeta la espera; cancelar lo invalida; de otra empresa o inexistente es 404', async () => {
    const r = await ok<{ id: string }>(await invite(T.alice, { email: 'nora@a.test', role: 'advisor' }), 201);
    const first = tokenOf(mail.lastInvitation('nora@a.test')!.inviteUrl);
    // la espera entre reenvíos (60 s por omisión en la prueba) frena el reenvío inmediato
    const again = await call('POST', `/users/invitations/${r.id}/resend`, T.alice);
    expect(again.status).toBe(429);
    await admin.query(`UPDATE invitations SET last_sent_at = now() - interval '5 minutes' WHERE id = $1`, [r.id]);
    const re = await ok<{ id: string }>(await call('POST', `/users/invitations/${r.id}/resend`, T.alice));
    const second = tokenOf(mail.lastInvitation('nora@a.test')!.inviteUrl);
    expect(second).not.toBe(first);
    expect((await accept(first)).status).toBe(400); // el anterior ya no vale
    // otra empresa no la ve ni la toca
    for (const p of [`/users/invitations/${re.id}/resend`, `/users/invitations/${re.id}/cancel`]) expect((await call('POST', p, T.bob)).status, p).toBe(404);
    expect((await list(T.bob)).invitations).toEqual([]);
    // cancelar
    await ok(await call('POST', `/users/invitations/${re.id}/cancel`, T.alice));
    expect((await accept(second)).status).toBe(400);
    expect((await list(T.alice)).invitations).toEqual([]);
    expect((await call('POST', `/users/invitations/${re.id}/cancel`, T.alice)).status).toBe(404);
    expect((await call('POST', `/users/invitations/${NOBODY}/resend`, T.alice)).status).toBe(404);
    // se puede volver a invitar al mismo correo
    await ok(await invite(T.alice, { email: 'nora@a.test', role: 'advisor' }), 201);
    expect((await list(T.alice)).invitations).toHaveLength(1);
  });
});

describe('desactivar y quitar', () => {
  it('DEBE elegirse qué pasa con las conversaciones: sin la elección, con una persona sin el traspaso o con datos de más, 400 y no cambia nada', async () => {
    for (const body of [undefined, {}, { conversations: {} }, { conversations: { action: 'transfer' } }, { conversations: { action: 'unassign', to_user_id: IDS.eve } }, { conversations: { action: 'otra' } }, { conversations: { action: 'unassign' }, extra: 1 }]) {
      expect((await call('POST', `/users/${IDS.carol}/deactivate`, T.alice, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await memberRow(IDS.carol)).revoked_at).toBeNull();
  });

  it('TRANSFERIR: sus conversaciones abiertas pasan a la otra persona («pendiente», con su lead y una nota interna); las finalizadas no se tocan; su sesión se cierra y sale de los departamentos', async () => {
    const q = await queue(T.alice, 'Ventas');
    await ok(await call('PUT', `/users/${IDS.carol}/departments`, T.alice, { queue_ids: [q] }));
    const open1 = await mkConv(IDS.carol);
    const open2 = await mkConv(IDS.carol, { status: 'waiting' });
    const closed = await mkConv(IDS.carol, { status: 'closed' });
    const other = await mkConv(IDS.eve);
    const r = await ok<Leave>(await call('POST', `/users/${IDS.carol}/deactivate`, T.alice, leaveBody('transfer', IDS.eve)));
    expect(r).toMatchObject({ user_id: IDS.carol, status: 'deactivated', conversations: { action: 'transfer', moved: 2, to_user_id: IDS.eve } });
    expect(r.sessions_revoked).toBeGreaterThanOrEqual(1);
    for (const c of [open1, open2]) {
      expect(await convRow(c.id)).toMatchObject({ status: 'pending', owner_id: IDS.eve });
      expect(await contactOwner(c.contact)).toBe(IDS.eve); // el lead se va con la conversación
    }
    expect(await convRow(closed.id)).toMatchObject({ status: 'closed', owner_id: IDS.carol });
    expect((await convRow(other.id)).owner_id).toBe(IDS.eve);
    const note = (await admin.query(`SELECT body, sender_type, kind, status FROM messages WHERE conversation_id = $1 AND kind = 'note'`, [open1.id])).rows;
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({ sender_type: 'system', status: 'internal' });
    expect(note[0].body).toMatch(/Carolina Vera dejó el equipo/);
    expect(note[0].body).toMatch(/Eva Mora/);
    // la persona: membresía desactivada, sesión cerrada, fuera del equipo activo y de los departamentos
    expect(await memberRow(IDS.carol)).toMatchObject({ revoked_reason: 'deactivated' });
    expect((await call('GET', '/conversations', T.carol)).status).toBe(401);
    const l = (await list(T.alice)).items.find((m) => m.user_id === IDS.carol)!;
    expect(l).toMatchObject({ status: 'deactivated', departments: [] });
    expect(l.deactivated_at).toBeTruthy();
    expect((await admin.query(`SELECT active FROM queue_members WHERE user_id = $1`, [IDS.carol])).rows.every((x) => x.active === false)).toBe(true);
    expect((await history()).map((h) => h.kind)).toContain('deactivated');
    expect((await audits(IDS.carol)).map((a) => a.field)).toContain('deactivated');
  });

  it('SIN ASIGNACIÓN: sus conversaciones abiertas quedan «sin asignar» (el contacto conserva su dueño) y deja una nota; también se quita su acceso como colaboradora', async () => {
    const mine = await mkConv(IDS.carol);
    const shared = await mkConv(IDS.eve);
    await admin.query(`INSERT INTO conversation_participants(id, organization_id, conversation_id, user_id, permission, added_by) VALUES (gen_random_uuid(), $1, $2, $3, 'view', $4)`, [ORG_A, shared.id, IDS.carol, IDS.eve]);
    const r = await ok<Leave>(await call('POST', `/users/${IDS.carol}/deactivate`, T.alice, leaveBody('unassign')));
    expect(r).toMatchObject({ conversations: { action: 'unassign', moved: 1, to_user_id: null }, collaborations_removed: 1 });
    expect(await convRow(mine.id)).toMatchObject({ status: 'unassigned', owner_id: null, assigned_at: null });
    expect(await contactOwner(mine.contact)).toBe(IDS.carol);
    expect((await admin.query(`SELECT body FROM messages WHERE conversation_id = $1 AND kind = 'note'`, [mine.id])).rows[0].body).toMatch(/sin asignar/);
    expect((await admin.query(`SELECT revoked_at FROM conversation_participants WHERE conversation_id = $1`, [shared.id])).rows[0].revoked_at).not.toBeNull();
    expect((await convRow(shared.id)).owner_id).toBe(IDS.eve); // la conversación de otra persona sigue igual
  });

  it('valida el destino: debe poder recibir trabajo (no ella misma, no desactivada, no de otra empresa); se comprueba ANTES de tocar nada', async () => {
    const c = await mkConv(IDS.carol);
    await ok(await call('POST', `/users/${IDS.eve}/deactivate`, T.alice, leaveBody('unassign')));
    for (const to of [IDS.carol, IDS.eve, IDS.gina, NOBODY]) {
      const r = await call('POST', `/users/${IDS.carol}/deactivate`, T.alice, leaveBody('transfer', to));
      expect(r.status, to).toBe(400);
      expect(await code(r)).toBe('TRANSFER_TARGET_NOT_ALLOWED');
    }
    expect(await convRow(c.id)).toMatchObject({ status: 'working', owner_id: IDS.carol });
    expect((await memberRow(IDS.carol)).revoked_at).toBeNull();
  });

  it('no a uno mismo (409 SELF_NOT_ALLOWED) ni al último administrador (409 LAST_ADMIN); y NO se tocan sus conversaciones si no se puede', async () => {
    expect(await code(await call('POST', `/users/${IDS.alice}/deactivate`, T.alice, leaveBody('unassign')))).toBe('SELF_NOT_ALLOWED');
    expect(await code(await call('POST', `/users/${IDS.alice}/remove`, T.alice, leaveBody('unassign')))).toBe('SELF_NOT_ALLOWED');
    const aliceConv = await mkConv(IDS.alice);
    await ok(await call('POST', `/users/${IDS.frank}/deactivate`, T.alice, leaveBody('unassign'))); // alice queda como la única
    const r = await call('POST', `/users/${IDS.alice}/deactivate`, T.carol, leaveBody('unassign')); // una asesora no puede (403): el guard
    expect(r.status).toBe(403);
    // frank (desactivado) reactivado vuelve a ser el segundo; ahora el último es quien queda tras quitar al otro
    await ok(await call('POST', `/users/${IDS.frank}/reactivate`, T.alice));
    const frank = await login('frank@a.test');
    await ok(await call('POST', `/users/${IDS.alice}/deactivate`, frank, leaveBody('transfer', IDS.eve)));
    expect(await convRow(aliceConv.id)).toMatchObject({ owner_id: IDS.eve });
    // frank es ahora el único administrador: nadie puede quitarlo y él no puede quitarse
    const stillAdmin = await call('POST', `/users/${IDS.frank}/remove`, frank, leaveBody('unassign'));
    expect(stillAdmin.status).toBe(409);
  });

  it('dos administradores que se desactivan entre sí a la vez: gana uno y la empresa NUNCA se queda sin administrador', async () => {
    const [a, b] = await Promise.all([call('POST', `/users/${IDS.frank}/deactivate`, T.alice, leaveBody('unassign')), call('POST', `/users/${IDS.alice}/deactivate`, T.frank, leaveBody('unassign'))]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect([a.status, b.status].some((s) => s === 409 || s === 401 || s === 403)).toBe(true);
    const admins = (await admin.query(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1 AND role = 'client_admin' AND revoked_at IS NULL`, [ORG_A])).rows[0].n as number;
    expect(admins).toBe(1);
  });

  it('REACTIVAR: vuelve con su rol y sus ajustes (membresía nueva), puede iniciar sesión otra vez y NO recupera lo que se transfirió; reactivar a quien no está desactivado es 404', async () => {
    await ok(await call('PUT', `/users/${IDS.carol}/permissions`, T.alice, { grant: ['contacts.export'], deny: [] }));
    const c = await mkConv(IDS.carol);
    await ok(await call('POST', `/users/${IDS.carol}/deactivate`, T.alice, leaveBody('transfer', IDS.eve)));
    expect((await call('POST', `/users/${IDS.eve}/reactivate`, T.alice)).status).toBe(404); // activa
    const r = await ok<Full>(await call('POST', `/users/${IDS.carol}/reactivate`, T.alice));
    expect(r).toMatchObject({ status: 'active', role: 'advisor', custom_permissions: true, overrides: { grant: ['contacts.export'], deny: [] }, departments: [] });
    expect((await convRow(c.id)).owner_id).toBe(IDS.eve);
    const again = await login('carol@a.test');
    expect((await exportAll(again)).status).toBe(200);
    expect(Number((await admin.query(`SELECT count(*) FROM organization_members WHERE user_id = $1 AND organization_id = $2`, [IDS.carol, ORG_A])).rows[0].count)).toBe(2); // la anterior queda como historia
    expect((await history()).map((h) => h.kind)).toEqual(expect.arrayContaining(['permissions_changed', 'deactivated', 'reactivated']));
  });

  it('QUITAR es definitivo: ya no figura, no se puede reactivar (404) y solo vuelve con una invitación nueva; su cuenta sigue existiendo', async () => {
    const c = await mkConv(IDS.carol);
    const r = await ok<Leave>(await call('POST', `/users/${IDS.carol}/remove`, T.alice, leaveBody('unassign')));
    expect(r).toMatchObject({ status: 'removed', conversations: { moved: 1 } });
    expect(await convRow(c.id)).toMatchObject({ status: 'unassigned' });
    expect(await memberRow(IDS.carol)).toMatchObject({ revoked_reason: 'removed' });
    expect((await list(T.alice)).items.map((m) => m.user_id)).not.toContain(IDS.carol);
    expect((await call('GET', `/users/${IDS.carol}`, T.alice)).status).toBe(404);
    expect((await call('POST', `/users/${IDS.carol}/reactivate`, T.alice)).status).toBe(404);
    expect(Number((await admin.query(`SELECT count(*) FROM users WHERE id = $1`, [IDS.carol])).rows[0].count)).toBe(1);
    // se puede invitar de nuevo y vuelve como miembro nuevo
    await ok(await call('POST', '/users/invitations', T.alice, { email: 'carol@a.test', role: 'advisor' }), 201);
    await ok(await call('POST', '/auth/invitations/accept', undefined, { token: tokenOf(mail.lastInvitation('carol@a.test')!.inviteUrl), password: PW }));
    expect((await list(T.alice)).items.find((m) => m.user_id === IDS.carol)).toMatchObject({ status: 'active' });
  });

  it('quitar a quien ya estaba desactivado también vale (y no pide un administrador de más)', async () => {
    await ok(await call('POST', `/users/${IDS.eve}/deactivate`, T.alice, leaveBody('unassign')));
    await ok(await call('POST', `/users/${IDS.eve}/remove`, T.alice, leaveBody('unassign')));
    expect((await memberRow(IDS.eve)).revoked_reason).toBe('removed');
    expect((await call('POST', `/users/${IDS.eve}/deactivate`, T.alice, leaveBody('unassign'))).status).toBe(404);
  });

  it('cerrar las sesiones de una persona la saca ahora mismo sin desactivarla; las de otra empresa no se tocan', async () => {
    const r = await ok<{ sessions_revoked: number }>(await call('POST', `/users/${IDS.eve}/sessions/revoke`, T.alice));
    expect(r.sessions_revoked).toBe(1);
    expect((await call('GET', '/conversations', T.eve)).status).toBe(401);
    expect((await memberRow(IDS.eve)).revoked_at).toBeNull(); // sigue en el equipo
    expect((await call('GET', '/conversations', T.gina)).status).toBe(200); // la asesora de B no se toca: su sesión sigue viva
    expect((await history()).map((h) => h.kind)).toContain('sessions_revoked');
  });

  it('A↔B: la desactivación de A no cambia nada de B', async () => {
    const bConv = await mkConv(IDS.gina, { org: ORG_B });
    await ok(await call('POST', `/users/${IDS.carol}/deactivate`, T.alice, leaveBody('unassign')));
    expect((await memberRow(IDS.gina, ORG_B)).revoked_at).toBeNull();
    expect((await call('POST', `/users/${IDS.gina}/deactivate`, T.alice, leaveBody('unassign'))).status).toBe(404);
    expect(await convRow(bConv.id)).toMatchObject({ status: 'working', owner_id: IDS.gina });
  });

  it('la historia del equipo lista lo ocurrido (más reciente primero) y solo de la empresa', async () => {
    await ok(await call('PATCH', `/users/${IDS.eve}`, T.alice, { role: 'client_admin' }));
    await ok(await call('POST', `/users/${IDS.carol}/deactivate`, T.alice, leaveBody('unassign')));
    const h = await ok<{ items: Array<{ kind: string; user_id: string | null; changed_by: string | null }> }>(await call('GET', '/users/history?limit=10', T.alice));
    expect(h.items.map((x) => x.kind)).toEqual(['deactivated', 'role_changed']);
    expect(h.items[0]).toMatchObject({ user_id: IDS.carol, changed_by: IDS.alice });
    expect((await ok<{ items: unknown[] }>(await call('GET', '/users/history', T.bob))).items).toEqual([]);
    expect((await call('GET', '/users/history?limit=0', T.alice)).status).toBe(400);
  });
});
