// M2.4 — Agencias y carteras (ADR-22, ADR-40). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   GET /v1/platform/agencies · POST /v1/platform/agencies · POST /v1/platform/agencies/:id/suspend · POST /v1/platform/agencies/:id/reactivate
//   GET /v1/platform/agencies/:id/history · PUT /v1/platform/organizations/:id/agency
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uuidv7 } from '@sales-smart/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { MAIL_PROVIDER, MemoryMailProvider } from '../../src/mail';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, ORG_C, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const NEW_PW = 'Nueva-Clave-2026';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AG2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  carol: 'c0000000-0000-4000-8000-0000000000c3', // advisor de A
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agency (AG1)
  eva: 'e0000000-0000-4000-8000-0000000000e5', // agency (AG1, segunda persona)
  frank: 'f1000000-0000-4000-8000-0000000000f6', // agency (AG2)
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
let admin: Client;
let app: INestApplication;
let base = '';
let mail: MemoryMailProvider;
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE sessions, auth_throttle, signup_attempts, trials, invitations, organization_ownership_history, organization_members, organizations, users, plans, platform_audit CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [ORG_C, 'client', 'Café Origen'], [AG1, 'agency', 'Agencia Uno'], [AG2, 'agency', 'Agencia Dos']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string]> = [[IDS.alice, 'alice@a.test'], [IDS.bob, 'bob@b.test'], [IDS.carol, 'carol@a.test'], [IDS.dave, 'dave@agencia1.test'], [IDS.eva, 'eva@agencia1.test'], [IDS.frank, 'frank@agencia2.test'], [IDS.root, 'root@plat.test']];
  for (const [id, email] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, hash]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.dave, AG1, 'agency'], [IDS.eva, AG1, 'agency'], [IDS.frank, AG2, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const codeOf = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const tokenOf = (url: string): string => new URL(url).hash.replace(/^#token=/, '');
interface AssignOut { id: string; agency: { id: string; name: string } | null; changed: boolean; notified: number }
interface AgencyRow { id: string; name: string; state: string; owner_email: string | null; clients: number; country: string | null; invitation: { email: string; expired: boolean } | null }
interface CompanyRow { id: string; kind: string; state: string; agency: { id: string; name: string } | null }
interface Member { email: string; role: string; access_level: string | null; revoked: boolean }

let rootToken = '';
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string, password = PW): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const assign = (orgId: string, agencyId: string | null, extra: Record<string, unknown> = {}) => call('PUT', `/platform/organizations/${orgId}/agency`, rootToken, { agency_id: agencyId, ...extra });
const agencies = async (qs = ''): Promise<{ items: AgencyRow[]; next_cursor: string | null }> => json(await call('GET', `/platform/agencies${qs}`, rootToken));
const companies = async (qs = ''): Promise<{ items: CompanyRow[] }> => json(await call('GET', `/platform/companies${qs}`, rootToken));
/** Membresías (vigentes y revocadas) de una organización, con el correo de la persona. */
async function members(orgId: string, role?: string): Promise<Member[]> {
  const r = await admin.query(
    `SELECT u.email, m.role, m.access_level, (m.revoked_at IS NOT NULL) AS revoked FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 ${role ? 'AND m.role = $2' : ''} ORDER BY u.email, m.created_at`,
    role ? [orgId, role] : [orgId],
  );
  return r.rows as Member[];
}
const active = async (orgId: string, role = 'agency'): Promise<string[]> => (await members(orgId, role)).filter((m) => !m.revoked).map((m) => m.email);
/** Sesión REAL de una persona con un contexto activo concreto (lo que dejará el cambio de contexto de M2.5): devuelve su token de acceso. */
async function sessionIn(userId: string, orgId: string): Promise<string> {
  const id = uuidv7();
  const secret = randomBytes(32).toString('base64url');
  const rsecret = randomBytes(32).toString('base64url');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  await admin.query(
    `INSERT INTO sessions(id, user_id, active_org_id, home_org_id, user_session_version, access_hash, access_expires_at, refresh_hash, refresh_expires_at, absolute_expires_at)
     VALUES ($1,$2,$3,$3,1,$4, now() + interval '1 hour', $5, now() + interval '1 day', now() + interval '2 days')`,
    [id, userId, orgId, sha(secret), sha(rsecret)],
  );
  return `${id}.${secret}`;
}
const me = (token: string) => call('GET', '/auth/me', token);

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'INVITATION_ATTEMPT_IP_MAX_PER_HOUR']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', INVITATION_ATTEMPT_IP_MAX_PER_HOUR: '500' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
  mail = app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  mail.inviteOutbox.length = 0;
  mail.ownershipOutbox.length = 0;
  rootToken = await login('root@plat.test');
});

describe('acceso: solo el Súper Admin', () => {
  it('sin sesión 401; cliente, asesor y agencia 403 en TODAS las rutas; no cambia nada', async () => {
    const tokens = [await login('alice@a.test'), await login('carol@a.test'), await login('dave@agencia1.test')];
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/platform/agencies'],
      ['POST', '/platform/agencies', { name: 'Hack', owner_email: 'x@x.test', timezone: 'UTC', country: 'EC' }],
      ['POST', `/platform/agencies/${AG1}/suspend`],
      ['POST', `/platform/agencies/${AG1}/reactivate`],
      ['GET', `/platform/agencies/${AG1}/history`],
      ['PUT', `/platform/organizations/${ORG_A}/agency`, { agency_id: AG1 }],
    ];
    for (const [m, p, body] of routes) {
      expect((await call(m, p, undefined, body)).status, `${m} ${p} sin sesión`).toBe(401);
      for (const t of tokens) expect((await call(m, p, t, body)).status, `${m} ${p} no super_admin`).toBe(403);
    }
    expect((await admin.query(`SELECT count(*)::int AS n FROM organizations WHERE parent_agency_id IS NOT NULL`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT status FROM organizations WHERE id = $1`, [AG1])).rows[0].status).toBe('active');
    expect((await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(6);
  });
});

describe('agencias', () => {
  it('lista las agencias con su dueño, su cartera y su estado; filtra y busca', async () => {
    await assign(ORG_A, AG1);
    const all = await agencies();
    expect(all.items.map((a) => a.name).sort()).toEqual(['Agencia Dos', 'Agencia Uno']);
    expect(all.items.find((a) => a.id === AG1)).toMatchObject({ state: 'active', clients: 1 });
    expect(all.items.find((a) => a.id === AG1)!.owner_email).toMatch(/@agencia1\.test$/);
    expect(all.items.find((a) => a.id === AG2)).toMatchObject({ state: 'active', clients: 0, owner_email: 'frank@agencia2.test' });
    expect((await agencies('?q=frank')).items.map((a) => a.id)).toEqual([AG2]);
    expect((await agencies('?state=suspended')).items).toEqual([]);
    expect((await call('GET', '/platform/agencies?state=otro', rootToken)).status).toBe(400);
    const page = await agencies('?limit=1');
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).not.toBeNull();
  });

  it('crear una agencia: 201, organización «agency» sin plan ni prueba, invitación con rol agency, correo de agencia y auditoría; el enlace NO viaja', async () => {
    const r = await call('POST', '/platform/agencies', rootToken, { name: 'Agencia Tres', owner_email: 'Dueno@Tres.test', timezone: 'America/Guayaquil', country: 'ec' });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const out = await json<{ company: { id: string; kind: string; state: string; plan: unknown; country: string }; invitation: { email: string; delivery: string; invite_url?: string } }>(r);
    expect(out.company).toMatchObject({ kind: 'agency', state: 'invited', plan: null, country: 'EC' });
    expect(out.invitation).toMatchObject({ email: 'dueno@tres.test', delivery: 'sent' });
    expect(out.invitation.invite_url).toBeUndefined();
    const org = (await admin.query(`SELECT kind, plan_id, parent_agency_id FROM organizations WHERE id = $1`, [out.company.id])).rows[0];
    expect(org).toEqual({ kind: 'agency', plan_id: null, parent_agency_id: null });
    expect((await admin.query(`SELECT role FROM invitations WHERE organization_id = $1`, [out.company.id])).rows[0].role).toBe('agency');
    const sent = mail.lastInvitation('dueno@tres.test')!;
    expect(sent).toMatchObject({ kind: 'agency', organizationName: 'Agencia Tres' });
    expect((await admin.query(`SELECT details FROM platform_audit WHERE action = 'agency.created'`)).rows).toHaveLength(1);
    const row = (await agencies('?state=invited')).items[0]!;
    expect(row).toMatchObject({ id: out.company.id, state: 'invited', clients: 0, owner_email: 'dueno@tres.test' });
    expect(row.invitation?.expired).toBe(false);
  });

  it('una agencia NO lleva plan: el campo plan_id se rechaza (400) y no se crea nada', async () => {
    const r = await call('POST', '/platform/agencies', rootToken, { name: 'Agencia X', owner_email: 'x@x.test', timezone: 'UTC', country: 'EC', plan_id: uuidv7() });
    expect(r.status).toBe(400);
    expect(await codeOf(r)).toBe('VALIDATION_ERROR');
    expect((await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(6);
  });

  it('el dueño acepta: queda como persona de la agencia (rol agency), SIN prueba, y la agencia pasa a «active»; el reenvío también funciona con agencias', async () => {
    const out = await json<{ company: { id: string } }>(await call('POST', '/platform/agencies', rootToken, { name: 'Agencia Tres', owner_email: 'dueno@tres.test', timezone: 'UTC', country: 'EC' }));
    const orgId = out.company.id;
    await admin.query(`UPDATE invitations SET last_sent_at = now() - interval '1 hour' WHERE organization_id = $1`, [orgId]);
    expect((await call('POST', `/platform/companies/${orgId}/invitation/resend`, rootToken)).status).toBe(200);
    expect(mail.lastInvitation('dueno@tres.test')?.kind).toBe('agency');
    const token = tokenOf(mail.lastInvitation('dueno@tres.test')!.inviteUrl);
    const acc = await call('POST', '/auth/invitations/accept', undefined, { token, password: NEW_PW, full_name: 'Dueña Tres', phone: '+593987654321' });
    expect(acc.status).toBe(200);
    expect(await members(orgId)).toEqual([{ email: 'dueno@tres.test', role: 'agency', access_level: null, revoked: false }]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM trials WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(0);
    expect((await agencies()).items.find((a) => a.id === orgId)).toMatchObject({ state: 'active', owner_email: 'dueno@tres.test' });
    expect((await admin.query(`SELECT action FROM platform_audit WHERE action LIKE 'agency.%' ORDER BY at`)).rows.map((x) => x.action)).toEqual(['agency.created', 'agency.invitation_resent']);
  });

  it('si ya hay clientes en la cartera cuando el dueño acepta, recibe acceso a todos ellos (invariante de ADR-40)', async () => {
    const out = await json<{ company: { id: string } }>(await call('POST', '/platform/agencies', rootToken, { name: 'Agencia Tres', owner_email: 'dueno@tres.test', timezone: 'UTC', country: 'EC' }));
    const orgId = out.company.id;
    expect((await assign(ORG_A, orgId)).status).toBe(200); // aún no hay nadie en la agencia
    expect((await assign(ORG_B, orgId)).status).toBe(200);
    expect(await active(ORG_A)).toEqual([]);
    const token = tokenOf(mail.lastInvitation('dueno@tres.test')!.inviteUrl);
    expect((await call('POST', '/auth/invitations/accept', undefined, { token, password: NEW_PW, full_name: 'Dueña Tres', phone: '+593987654321' })).status).toBe(200);
    expect(await active(ORG_A)).toEqual(['dueno@tres.test']);
    expect(await active(ORG_B)).toEqual(['dueno@tres.test']);
    expect(await members(ORG_A, 'agency')).toEqual([{ email: 'dueno@tres.test', role: 'agency', access_level: 'admin', revoked: false }]);
  });
});

describe('carteras: asignar, mover y quitar clientes', () => {
  it('asignar: cambia SOLO parent_agency_id, da acceso a las personas de la agencia con nivel «admin», escribe el historial, audita y avisa al administrador del cliente', async () => {
    const before = (await admin.query(`SELECT plan_id, status, name, timezone FROM organizations WHERE id = $1`, [ORG_A])).rows[0];
    const r = await assign(ORG_A, AG1, { reason: 'Cliente nuevo de la agencia' });
    expect(r.status).toBe(200);
    expect(await json<AssignOut>(r)).toMatchObject({ id: ORG_A, agency: { id: AG1, name: 'Agencia Uno' }, changed: true, notified: 1 });
    expect((await admin.query(`SELECT parent_agency_id FROM organizations WHERE id = $1`, [ORG_A])).rows[0].parent_agency_id).toBe(AG1);
    expect((await admin.query(`SELECT plan_id, status, name, timezone FROM organizations WHERE id = $1`, [ORG_A])).rows[0]).toEqual(before); // plan, estado y datos no cambian
    expect(await members(ORG_A, 'agency')).toEqual([
      { email: 'dave@agencia1.test', role: 'agency', access_level: 'admin', revoked: false },
      { email: 'eva@agencia1.test', role: 'agency', access_level: 'admin', revoked: false },
    ]);
    expect(await active(ORG_A, 'client_admin')).toEqual(['alice@a.test']); // el administrador del cliente sigue intacto
    const h = (await admin.query(`SELECT from_agency_id, to_agency_id, reason, notify_client, changed_by FROM organization_ownership_history WHERE organization_id = $1`, [ORG_A])).rows;
    expect(h).toEqual([{ from_agency_id: null, to_agency_id: AG1, reason: 'Cliente nuevo de la agencia', notify_client: true, changed_by: IDS.root }]);
    const audit = (await admin.query(`SELECT target_org_id, actor_user_id, details FROM platform_audit WHERE action = 'client.agency_changed'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ target_org_id: ORG_A, actor_user_id: IDS.root });
    expect(audit[0].details).toMatchObject({ from_agency_id: null, to_agency_id: AG1, access_granted: 2, access_revoked: 0 });
    expect(mail.ownershipOutbox).toEqual([{ to: 'alice@a.test', organizationName: 'Barbería Norte', agencyName: 'Agencia Uno', previousAgencyName: null }]);
    // la lista de empresas y la de agencias lo reflejan
    expect((await companies()).items.find((c) => c.id === ORG_A)!.agency).toEqual({ id: AG1, name: 'Agencia Uno' });
    expect((await agencies()).items.find((a) => a.id === AG1)!.clients).toBe(1);
  });

  it('repetir la misma asignación no hace nada (changed:false, sin historial ni correo)', async () => {
    await assign(ORG_A, AG1);
    mail.ownershipOutbox.length = 0;
    const again = await assign(ORG_A, AG1);
    expect(await json<AssignOut>(again)).toMatchObject({ changed: false, notified: 0 });
    expect((await admin.query(`SELECT count(*)::int AS n FROM organization_ownership_history`)).rows[0].n).toBe(1);
    expect(mail.ownershipOutbox).toEqual([]);
    const direct = await assign(ORG_B, null); // ya está en administración directa
    expect(await json<AssignOut>(direct)).toMatchObject({ agency: null, changed: false });
  });

  it('mover de AG1 a AG2: AG1 pierde el acceso AL INSTANTE (la sesión abierta en el cliente deja de valer), AG2 lo recibe, y el historial lo recuerda', async () => {
    await assign(ORG_A, AG1);
    const dave = await sessionIn(IDS.dave, ORG_A); // contexto activo = el cliente (lo que hará el cambio de contexto de M2.5)
    const okBefore = await me(dave);
    expect(okBefore.status).toBe(200);
    expect(await json(okBefore)).toMatchObject({ organization: { id: ORG_A }, role: 'agency' });
    mail.ownershipOutbox.length = 0;

    const r = await assign(ORG_A, AG2);
    expect(await json<AssignOut>(r)).toMatchObject({ agency: { id: AG2 }, changed: true });
    expect((await me(dave)).status).toBe(401); // criterio de aceptación de M2: quitar un cliente cierra el acceso al instante
    const sess = (await admin.query(`SELECT revoked_at, revoke_reason FROM sessions WHERE user_id = $1 AND active_org_id = $2`, [IDS.dave, ORG_A])).rows[0];
    expect(sess.revoke_reason).toBe('access_removed');
    expect(sess.revoked_at).not.toBeNull();
    expect(await active(ORG_A)).toEqual(['frank@agencia2.test']);
    expect((await members(ORG_A, 'agency')).filter((m) => m.revoked).map((m) => m.email)).toEqual(['dave@agencia1.test', 'eva@agencia1.test']); // revocadas, no borradas
    // dave sigue siendo persona de su propia agencia: su acceso a ella no se toca
    expect((await me(await login('dave@agencia1.test'))).status).toBe(200);
    expect(mail.ownershipOutbox).toEqual([{ to: 'alice@a.test', organizationName: 'Barbería Norte', agencyName: 'Agencia Dos', previousAgencyName: 'Agencia Uno' }]);
    const hist = (await admin.query(`SELECT from_agency_id, to_agency_id FROM organization_ownership_history WHERE organization_id = $1 ORDER BY changed_at`, [ORG_A])).rows;
    expect(hist).toEqual([{ from_agency_id: null, to_agency_id: AG1 }, { from_agency_id: AG1, to_agency_id: AG2 }]);
  });

  it('quitar (administración directa): la agencia pierde el acceso, el cliente sigue funcionando y el aviso lo dice', async () => {
    await assign(ORG_A, AG1);
    mail.ownershipOutbox.length = 0;
    const r = await assign(ORG_A, null, { reason: 'El cliente prefiere administrarse solo' });
    expect(await json<AssignOut>(r)).toMatchObject({ agency: null, changed: true, notified: 1 });
    expect((await admin.query(`SELECT parent_agency_id FROM organizations WHERE id = $1`, [ORG_A])).rows[0].parent_agency_id).toBeNull();
    expect(await active(ORG_A)).toEqual([]);
    expect(mail.ownershipOutbox).toEqual([{ to: 'alice@a.test', organizationName: 'Barbería Norte', agencyName: null, previousAgencyName: 'Agencia Uno' }]);
    expect((await me(await login('alice@a.test'))).status).toBe(200); // el cliente no se entera de nada más
    expect((await companies()).items.find((c) => c.id === ORG_A)!.agency).toBeNull();
  });

  it('notify_client:false no envía correo; un fallo del correo NO deshace el cambio; sin administrador activo no hay a quién avisar', async () => {
    expect(await json<AssignOut>(await assign(ORG_A, AG1, { notify_client: false }))).toMatchObject({ changed: true, notified: 0 });
    expect(mail.ownershipOutbox).toEqual([]);
    expect((await admin.query(`SELECT notify_client FROM organization_ownership_history WHERE organization_id = $1`, [ORG_A])).rows[0].notify_client).toBe(false);
    mail.failNext = true;
    const failed = await assign(ORG_B, AG1);
    expect(failed.status).toBe(200);
    expect(await json<AssignOut>(failed)).toMatchObject({ changed: true, notified: 0 });
    expect((await admin.query(`SELECT parent_agency_id FROM organizations WHERE id = $1`, [ORG_B])).rows[0].parent_agency_id).toBe(AG1);
    expect(await json<AssignOut>(await assign(ORG_C, AG1))).toMatchObject({ changed: true, notified: 0 }); // ORG_C no tiene administrador
  });

  it('errores: agencia inexistente o que no es agencia → 404; suspendida → 409; el destino no es un cliente → 404; UUID/campos inválidos → 400; nada cambia', async () => {
    const missing = await assign(ORG_A, uuidv7());
    expect(missing.status).toBe(404);
    expect(await codeOf(missing)).toBe('AGENCY_NOT_FOUND');
    expect((await assign(ORG_A, ORG_B)).status).toBe(404); // un cliente no es una agencia
    await admin.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [AG2]);
    const susp = await assign(ORG_A, AG2);
    expect(susp.status).toBe(409);
    expect(await codeOf(susp)).toBe('AGENCY_SUSPENDED');
    expect((await assign(AG1, AG2)).status).toBe(404); // una agencia no se administra desde otra
    expect((await assign(IDS.platformOrg, AG1)).status).toBe(404);
    expect((await assign(uuidv7(), AG1)).status).toBe(404);
    expect((await call('PUT', `/platform/organizations/no-es-uuid/agency`, rootToken, { agency_id: AG1 })).status).toBe(400);
    for (const body of [{}, { agency_id: 'no-uuid' }, { agency_id: AG1, organization_id: ORG_B }, { agency_id: AG1, reason: 'x'.repeat(301) }, { agency_id: AG1, notify_client: 'si' }]) {
      expect((await call('PUT', `/platform/organizations/${ORG_A}/agency`, rootToken, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect((await admin.query(`SELECT count(*)::int AS n FROM organizations WHERE parent_agency_id IS NOT NULL`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM organization_ownership_history`)).rows[0].n).toBe(0);
  });

  it('una persona que ya es administradora del cliente Y de la agencia no recibe una segunda membresía ni pierde la suya al mover el cliente', async () => {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,'agency')`, [IDS.alice, AG1]); // alice también trabaja en la agencia
    await assign(ORG_A, AG1);
    expect((await members(ORG_A)).filter((m) => m.email === 'alice@a.test')).toEqual([{ email: 'alice@a.test', role: 'client_admin', access_level: null, revoked: false }]);
    await assign(ORG_A, AG2);
    expect(await active(ORG_A, 'client_admin')).toEqual(['alice@a.test']); // su rol de administradora no se toca
  });

  it('las personas que son de las DOS agencias conservan el acceso al pasar de una a otra (sin revocar ni duplicar)', async () => {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,'agency')`, [IDS.dave, AG2]);
    await assign(ORG_A, AG1);
    await assign(ORG_A, AG2);
    expect((await members(ORG_A, 'agency')).filter((m) => m.email === 'dave@agencia1.test')).toEqual([{ email: 'dave@agencia1.test', role: 'agency', access_level: 'admin', revoked: false }]);
    expect(await active(ORG_A)).toEqual(['dave@agencia1.test', 'frank@agencia2.test']);
  });

  it('la lista de empresas filtra por agencia (la cartera) y por «none» (administración directa)', async () => {
    await assign(ORG_A, AG1);
    await assign(ORG_B, AG1);
    expect((await companies(`?agency=${AG1}`)).items.map((c) => c.id).sort()).toEqual([ORG_A, ORG_B].sort());
    expect((await companies(`?agency=${AG2}`)).items).toEqual([]);
    const direct = (await companies('?agency=none')).items.map((c) => c.id);
    expect(direct).toEqual([ORG_C]);
    expect((await call('GET', '/platform/companies?agency=cualquiera', rootToken)).status).toBe(400);
  });
});

describe('suspender y reactivar una agencia', () => {
  it('suspender: sus personas pierden el acceso a los clientes AL INSTANTE y a su propia agencia; los clientes siguen funcionando; reactivar restituye todo; ambas son idempotentes', async () => {
    await assign(ORG_A, AG1);
    await assign(ORG_B, AG1);
    const dave = await sessionIn(IDS.dave, ORG_A);
    expect((await me(dave)).status).toBe(200);

    const r = await call('POST', `/platform/agencies/${AG1}/suspend`, rootToken);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ id: AG1, state: 'suspended', changed: true, revoked: 4 });
    expect((await me(dave)).status).toBe(401);
    expect(await active(ORG_A)).toEqual([]);
    expect(await active(ORG_B)).toEqual([]);
    expect((await call('POST', '/auth/login', undefined, { email: 'dave@agencia1.test', password: PW, token_transport: 'body' })).status).toBe(401); // agencia suspendida no entra
    expect((await me(await login('alice@a.test'))).status).toBe(200); // los clientes siguen funcionando
    expect((await me(await login('bob@b.test'))).status).toBe(200);
    expect((await agencies()).items.find((a) => a.id === AG1)).toMatchObject({ state: 'suspended', clients: 2 }); // la cartera se conserva
    expect((await admin.query(`SELECT parent_agency_id FROM organizations WHERE id = $1`, [ORG_A])).rows[0].parent_agency_id).toBe(AG1);
    expect(await json(await call('POST', `/platform/agencies/${AG1}/suspend`, rootToken))).toMatchObject({ changed: false, revoked: 0 });

    const back = await call('POST', `/platform/agencies/${AG1}/reactivate`, rootToken);
    expect(await json(back)).toMatchObject({ state: 'active', changed: true, granted: 4 });
    expect(await active(ORG_A)).toEqual(['dave@agencia1.test', 'eva@agencia1.test']);
    expect(await active(ORG_B)).toEqual(['dave@agencia1.test', 'eva@agencia1.test']);
    expect((await call('POST', '/auth/login', undefined, { email: 'dave@agencia1.test', password: PW, token_transport: 'body' })).status).toBe(200);
    expect(await json(await call('POST', `/platform/agencies/${AG1}/reactivate`, rootToken))).toMatchObject({ changed: false, granted: 0 });
    expect((await admin.query(`SELECT action FROM platform_audit WHERE action IN ('agency.suspended','agency.reactivated') ORDER BY at`)).rows.map((x) => x.action)).toEqual(['agency.suspended', 'agency.reactivated']);
  });

  it('404 si no es una agencia o no existe', async () => {
    for (const id of [ORG_A, IDS.platformOrg, uuidv7()]) {
      expect((await call('POST', `/platform/agencies/${id}/suspend`, rootToken)).status, id).toBe(404);
      expect((await call('POST', `/platform/agencies/${id}/reactivate`, rootToken)).status, id).toBe(404);
    }
    expect((await call('POST', `/platform/agencies/no-es-uuid/suspend`, rootToken)).status).toBe(400);
  });
});

describe('historial de la cartera', () => {
  it('muestra los cambios donde la agencia fue origen o destino, con nombres, motivo, aviso y quién lo hizo; más reciente primero', async () => {
    await assign(ORG_A, AG1, { reason: 'Alta' });
    await assign(ORG_B, AG1);
    await assign(ORG_A, AG2, { reason: 'Se muda de agencia', notify_client: false });
    const h1 = await json<{ items: Array<{ organization: { name: string }; from: { name: string } | null; to: { name: string } | null; reason: string | null; notify_client: boolean; changed_by: string | null }> }>(await call('GET', `/platform/agencies/${AG1}/history`, rootToken));
    expect(h1.items).toHaveLength(3);
    expect(h1.items[0]).toMatchObject({ organization: { name: 'Barbería Norte' }, from: { name: 'Agencia Uno' }, to: { name: 'Agencia Dos' }, reason: 'Se muda de agencia', notify_client: false, changed_by: 'root@plat.test' });
    expect(h1.items.map((i) => i.organization.name)).toEqual(['Barbería Norte', 'Estudio Luna', 'Barbería Norte']);
    const h2 = await json<{ items: unknown[] }>(await call('GET', `/platform/agencies/${AG2}/history`, rootToken));
    expect(h2.items).toHaveLength(1);
    expect((await call('GET', `/platform/agencies/${ORG_A}/history`, rootToken)).status).toBe(404); // no es una agencia
    expect((await call('GET', `/platform/agencies/${uuidv7()}/history`, rootToken)).status).toBe(404);
  });
});

describe('base de datos', () => {
  it('parent_agency_id solo puede apuntar a una AGENCIA (trigger); el nivel de acceso solo admite read|advisor|admin', async () => {
    await expect(admin.query(`UPDATE organizations SET parent_agency_id = $1 WHERE id = $2`, [ORG_B, ORG_A])).rejects.toThrow(/debe apuntar a una organización de tipo agency/);
    await expect(admin.query(`UPDATE organizations SET parent_agency_id = $1 WHERE id = $2`, [IDS.platformOrg, ORG_A])).rejects.toThrow(/debe apuntar a una organización de tipo agency/);
    await admin.query(`UPDATE organizations SET parent_agency_id = $1 WHERE id = $2`, [AG1, ORG_A]); // una agencia sí
    await expect(admin.query(`UPDATE organization_members SET access_level = 'superuser' WHERE user_id = $1`, [IDS.alice])).rejects.toThrow(/organization_members_access_level_valid/);
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1`, [IDS.alice]);
  });

  it('el historial es APPEND-ONLY y solo lo toca app_identity: ni UPDATE ni DELETE; app_rw y app_platform no lo leen', async () => {
    await assign(ORG_A, AG1);
    const id = new Client({ connectionString: info.identityUrl });
    await id.connect();
    try {
      expect((await id.query(`SELECT count(*)::int AS n FROM organization_ownership_history`)).rows[0].n).toBe(1);
      await expect(id.query(`UPDATE organization_ownership_history SET reason = 'x'`)).rejects.toThrow(/permission denied/i);
      await expect(id.query(`DELETE FROM organization_ownership_history`)).rejects.toThrow(/permission denied/i);
    } finally { await id.end(); }
    for (const url of [info.rwUrl, info.platformUrl]) {
      const c = new Client({ connectionString: url });
      await c.connect();
      try { await expect(c.query(`SELECT 1 FROM organization_ownership_history`)).rejects.toThrow(/permission denied/i); } finally { await c.end(); }
    }
  });

  it('el historial exige que origen y destino difieran y que el motivo no esté vacío', async () => {
    const row = (from: string | null, to: string | null, reason: string | null) =>
      admin.query(`INSERT INTO organization_ownership_history(id, organization_id, from_agency_id, to_agency_id, reason, changed_by) VALUES ($1,$2,$3,$4,$5,$6)`, [uuidv7(), ORG_A, from, to, reason, IDS.root]);
    await expect(row(AG1, AG1, null)).rejects.toThrow(/ownership_history_changed/);
    await expect(row(null, null, null)).rejects.toThrow(/ownership_history_changed/);
    await expect(row(null, AG1, '   ')).rejects.toThrow(/ownership_history_reason_len/);
    await row(null, AG1, 'ok');
  });
});
