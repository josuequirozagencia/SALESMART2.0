// M2.5 — Cambio de contexto, soporte del Súper Admin, registro de accesos y «Mis clientes» (ADR-11/21/22/41, flujo F02). Rutas cubiertas
// (el registro de endpoints exige que este archivo las mencione):
//   POST /v1/context/switch · GET /v1/context/options · GET /v1/platform/access-sessions · PUT /v1/platform/organizations/:id/agency-access
//   GET /v1/agency/clients · POST /v1/agency/clients · POST /v1/agency/clients/:id/invitation/resend
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { MAIL_PROVIDER, MemoryMailProvider } from '../../src/mail';
import { AuthModule, IdentityCleanupJob, LocalAccessResolver } from '../../src/modules/auth';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, ORG_C, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AG2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOBODY = '99999999-9999-4999-8999-999999999999';
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
let rootToken = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE access_sessions, sessions, auth_throttle, signup_attempts, trials, invitations, organization_ownership_history, organization_members, organizations, users, plans, platform_audit, audit_logs CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [ORG_C, 'client', 'Café Origen'], [AG1, 'agency', 'Agencia Uno'], [AG2, 'agency', 'Agencia Dos']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string]> = [[IDS.alice, 'alice@a.test'], [IDS.bob, 'bob@b.test'], [IDS.carol, 'carol@a.test'], [IDS.dave, 'dave@agencia1.test'], [IDS.eva, 'eva@agencia1.test'], [IDS.frank, 'frank@agencia2.test'], [IDS.root, 'root@plat.test']];
  for (const [id, email] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, hash]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.dave, AG1, 'agency'], [IDS.eva, AG1, 'agency'], [IDS.frank, AG2, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

interface Me { user: { id: string; email: string }; organization: { id: string; name: string; kind: string }; role: string; home: { id: string; name: string; kind: string }; acting_as: string | null; read_only: boolean; access_level: string | null }
interface AccessItem { id: string; actor: { email: string; name: string | null }; actor_role: string; organization: { id: string; name: string; kind: string }; started_at: string; ended_at: string | null; end_reason: string | null; open: boolean; duration_seconds: number }
interface Company { id: string; name: string; kind: string; state: string; plan: unknown; agency: { id: string; name: string } | null; agency_access_level: string | null; invitation: { email: string } | null }

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string, password = PW): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const me = async (t: string): Promise<Me> => json<Me>(await call('GET', '/auth/me', t));
const sw = (t: string, target: string | null) => call('POST', '/context/switch', t, { target });
const assign = (orgId: string, agencyId: string | null) => call('PUT', `/platform/organizations/${orgId}/agency`, rootToken, { agency_id: agencyId });
const setLevel = (orgId: string, level: string) => call('PUT', `/platform/organizations/${orgId}/agency-access`, rootToken, { level });
const accessList = async (qs = '', token = rootToken) => json<{ items: AccessItem[]; next_cursor: string | null }>(await call('GET', `/platform/access-sessions${qs}`, token));
const myClients = async (t: string, qs = '') => json<{ items: Company[]; next_cursor: string | null }>(await call('GET', `/agency/clients${qs}`, t));
const sessionIdOf = (token: string): string => token.split('.')[0]!;
const errOf = async (r: Response) => (await json<{ error: { code: string; message: string } }>(r)).error;
const tokenOf = (url: string): string => new URL(url).hash.replace(/^#token=/, '');

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
  rootToken = await login('root@plat.test');
});

describe('acceso por rol', () => {
  it('sin sesión 401 en todas las rutas nuevas', async () => {
    const routes: Array<[string, string, unknown?]> = [
      ['POST', '/context/switch', { target: null }],
      ['GET', '/context/options'],
      ['GET', '/platform/access-sessions'],
      ['PUT', `/platform/organizations/${ORG_A}/agency-access`, { level: 'read' }],
      ['GET', '/agency/clients'],
      ['POST', '/agency/clients', { name: 'X', owner_email: 'x@x.test', timezone: 'UTC', country: 'EC' }],
      ['POST', `/agency/clients/${ORG_A}/invitation/resend`],
    ];
    for (const [m, p, b] of routes) expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
  });

  it('el historial de accesos y el nivel de acceso son SOLO del Súper Admin: cliente, asesor y agencia reciben 403', async () => {
    await assign(ORG_A, AG1);
    const tokens = [await login('alice@a.test'), await login('carol@a.test'), await login('dave@agencia1.test')];
    for (const t of tokens) {
      expect((await call('GET', '/platform/access-sessions', t)).status).toBe(403);
      expect((await call('PUT', `/platform/organizations/${ORG_A}/agency-access`, t, { level: 'read' })).status).toBe(403);
    }
    // incluso una agencia DENTRO de un cliente (con nivel de administrador) no ve el historial
    const dave = await login('dave@agencia1.test');
    expect((await sw(dave, ORG_A)).status).toBe(200);
    expect((await call('GET', '/platform/access-sessions', dave)).status).toBe(403);
  });

  it('«Mis clientes» y «Registrar cliente» exigen el rol de agencia en SU organización: cliente, asesor y Súper Admin (plataforma) → 403', async () => {
    const tokens = [await login('alice@a.test'), await login('carol@a.test'), rootToken];
    for (const t of tokens) {
      expect((await call('GET', '/agency/clients', t)).status).toBe(403);
      expect((await call('POST', '/agency/clients', t, { name: 'X', owner_email: 'x@x.test', timezone: 'UTC', country: 'EC' })).status).toBe(403);
      expect((await call('POST', `/agency/clients/${ORG_A}/invitation/resend`, t)).status).toBe(403);
    }
    expect((await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(6);
  });

  it('una agencia DENTRO de un cliente no recibe los permisos de la consola de agencia (ni siquiera con nivel administrador)', async () => {
    await assign(ORG_A, AG1);
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    expect((await call('GET', '/agency/clients', dave)).status).toBe(403);
    expect((await call('POST', '/agency/clients', dave, { name: 'X', owner_email: 'x@x.test', timezone: 'UTC', country: 'EC' })).status).toBe(403);
  });
});

describe('la agencia entra solo a su cartera', () => {
  it('entra a un cliente de su cartera, sin cerrar sesión: contexto, rol y nivel visibles, y vuelve a su agencia', async () => {
    await assign(ORG_A, AG1);
    const dave = await login('dave@agencia1.test');
    expect(await me(dave)).toMatchObject({ organization: { id: AG1, kind: 'agency' }, home: { id: AG1 }, acting_as: null, access_level: null });

    const r = await sw(dave, ORG_A);
    expect(r.status).toBe(200);
    expect(await json<Me>(r)).toMatchObject({ organization: { id: ORG_A, name: 'Barbería Norte', kind: 'client' }, role: 'agency', home: { id: AG1, name: 'Agencia Uno' }, acting_as: 'agency', access_level: 'admin', read_only: false });
    expect(await me(dave)).toMatchObject({ organization: { id: ORG_A }, acting_as: 'agency' }); // el MISMO token sigue valiendo

    const back = await sw(dave, null);
    expect(back.status).toBe(200);
    expect(await json<Me>(back)).toMatchObject({ organization: { id: AG1 }, acting_as: null, access_level: null });
    // volver estando ya en casa no cambia nada
    expect((await sw(dave, null)).status).toBe(200);
  });

  it('un cliente ajeno, otra agencia, la plataforma o un id inexistente son el MISMO 404 (no revela existencia) y el contexto no cambia', async () => {
    await assign(ORG_A, AG1);
    await assign(ORG_B, AG2);
    const dave = await login('dave@agencia1.test');
    const bodies: unknown[] = [];
    for (const target of [ORG_B, ORG_C, AG2, IDS.platformOrg, NOBODY]) {
      const r = await sw(dave, target);
      expect(r.status, `target ${target}`).toBe(404);
      const e = await errOf(r);
      bodies.push({ code: e.code, message: e.message });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
    expect(await me(dave)).toMatchObject({ organization: { id: AG1 }, acting_as: null });
    // la otra agencia tampoco entra al cliente de Dave
    const frank = await login('frank@agencia2.test');
    expect((await sw(frank, ORG_A)).status).toBe(404);
    expect((await sw(frank, ORG_B)).status).toBe(200);
    // un administrador de cliente solo entra donde tiene membresía
    const alice = await login('alice@a.test');
    expect((await sw(alice, ORG_B)).status).toBe(404);
    expect((await sw(alice, IDS.platformOrg)).status).toBe(404);
    expect((await sw(alice, AG1)).status).toBe(404);
  });

  it('el cuerpo se valida: target obligatorio, UUID o null, sin campos extra', async () => {
    const dave = await login('dave@agencia1.test');
    for (const body of [{}, { target: 'no-es-uuid' }, { target: 5 }, { target: null, organization_id: ORG_A }, { target: ORG_A, role: 'super_admin' }]) {
      expect((await call('POST', '/context/switch', dave, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('a un cliente suspendido o borrado no se entra (404)', async () => {
    await assign(ORG_A, AG1);
    const dave = await login('dave@agencia1.test');
    await admin.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ORG_A]);
    expect((await sw(dave, ORG_A)).status).toBe(404);
    await admin.query(`UPDATE organizations SET status = 'active', deleted_at = now() WHERE id = $1`, [ORG_A]);
    expect((await sw(dave, ORG_A)).status).toBe(404);
  });

  it('quitar al cliente de la cartera corta el acceso AL INSTANTE: la sesión abierta en el cliente vuelve a la agencia (no se pierde el inicio de sesión) y la entrada se cierra', async () => {
    await assign(ORG_A, AG1);
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    expect((await me(dave)).organization.id).toBe(ORG_A);

    expect((await assign(ORG_A, null)).status).toBe(200);
    // la MISMA petición siguiente ya no ve al cliente: sigue con su sesión, ahora en su agencia
    expect(await me(dave)).toMatchObject({ organization: { id: AG1 }, acting_as: null });
    expect((await sw(dave, ORG_A)).status).toBe(404);
    const row = (await accessList('?actor_role=agency')).items[0]!;
    expect(row).toMatchObject({ open: false, end_reason: 'access_removed', organization: { id: ORG_A } });
  });

  it('mover el cliente de AG1 a AG2: AG1 pierde el acceso, AG2 lo recibe con el nivel del cliente', async () => {
    await assign(ORG_A, AG1);
    await setLevel(ORG_A, 'advisor');
    await assign(ORG_A, AG2);
    const dave = await login('dave@agencia1.test');
    const frank = await login('frank@agencia2.test');
    expect((await sw(dave, ORG_A)).status).toBe(404);
    expect(await json<Me>(await sw(frank, ORG_A))).toMatchObject({ acting_as: 'agency', access_level: 'advisor' });
  });

  it('suspender la agencia: sus personas pierden el acceso al cliente y a su propia agencia (la sesión deja de valer); el cliente sigue funcionando', async () => {
    await assign(ORG_A, AG1);
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    expect((await call('POST', `/platform/agencies/${AG1}/suspend`, rootToken)).status).toBe(200);
    expect((await call('GET', '/auth/me', dave)).status).toBe(401);
    const alice = await login('alice@a.test');
    expect((await me(alice)).organization.id).toBe(ORG_A);
  });
});

describe('nivel de acceso por cliente', () => {
  const extension = (t: string) => call('POST', '/trials/me/extension', t, { reason: 'Necesitamos más tiempo para configurar' });

  it('por defecto «administrador»; el Súper Admin lo cambia y rige en la siguiente petición: lectura y asesor no administran, administrador sí', async () => {
    await assign(ORG_A, AG1);
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    expect((await extension(dave)).status).not.toBe(403); // administrador: pasa el guard de permisos (el resultado de negocio es otro asunto)

    expect(await json<{ level: string; changed: boolean }>(await setLevel(ORG_A, 'read'))).toEqual({ id: ORG_A, level: 'read', changed: true });
    expect(await me(dave)).toMatchObject({ access_level: 'read', read_only: true, acting_as: 'agency' });
    expect((await extension(dave)).status).toBe(403);
    expect((await call('GET', '/trials/me', dave)).status).not.toBe(403); // ver sí (la ruta responde por su lógica: esta empresa no tiene prueba)

    await setLevel(ORG_A, 'advisor');
    expect(await me(dave)).toMatchObject({ access_level: 'advisor', read_only: false });
    expect((await extension(dave)).status).toBe(403);

    await setLevel(ORG_A, 'admin');
    expect((await extension(dave)).status).not.toBe(403);
    // y las membresías de la agencia reflejan el nivel (todas las personas)
    const lv = await admin.query(`SELECT DISTINCT access_level FROM organization_members WHERE organization_id = $1 AND role = 'agency' AND revoked_at IS NULL`, [ORG_A]);
    expect(lv.rows.map((r) => r.access_level)).toEqual(['admin']);
  });

  it('el nivel pertenece al cliente: una persona de la agencia que se suma DESPUÉS recibe el nivel fijado, no el de por defecto', async () => {
    await assign(ORG_A, AG1);
    await setLevel(ORG_A, 'read');
    // Nueva persona de la agencia: se reconcilia con el mismo mecanismo de la aceptación de invitaciones
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES (gen_random_uuid(),'gina@agencia1.test',$1,'active',now())`, [hash]);
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) SELECT gen_random_uuid(), id, $1, 'agency' FROM users WHERE email = 'gina@agencia1.test'`, [AG1]);
    expect((await call('PUT', `/platform/organizations/${ORG_A}/agency`, rootToken, { agency_id: AG1 })).status).toBe(200); // no-op: no reconcilia
    const { AgencyAccessService } = await import('../../src/modules/organizations');
    const { Database } = await import('../../src/db');
    await app.get(Database, { strict: false }).withIdentity((tx) => app.get(AgencyAccessService, { strict: false }).reconcileClient(tx, ORG_A, null));
    const gina = await login('gina@agencia1.test');
    expect(await json<Me>(await sw(gina, ORG_A))).toMatchObject({ access_level: 'read', read_only: true });
  });

  it('validación: nivel inválido 400; cliente sin agencia 409; una agencia, la plataforma o un id inexistente 404; repetir el mismo nivel no cambia nada', async () => {
    expect((await setLevel(ORG_A, 'admin')).status).toBe(409); // sin agencia
    await assign(ORG_A, AG1);
    for (const level of ['owner', '', 'ADMIN']) expect((await setLevel(ORG_A, level)).status, level).toBe(400);
    expect((await call('PUT', `/platform/organizations/${ORG_A}/agency-access`, rootToken, { level: 'read', extra: 1 })).status).toBe(400);
    expect((await setLevel(AG1, 'read')).status).toBe(404);
    expect((await setLevel(IDS.platformOrg, 'read')).status).toBe(404);
    expect((await setLevel(NOBODY, 'read')).status).toBe(404);
    expect(await json<{ changed: boolean }>(await setLevel(ORG_A, 'admin'))).toMatchObject({ changed: false });
    expect((await admin.query(`SELECT action FROM platform_audit WHERE action = 'client.agency_access_changed'`)).rows).toEqual([]);
    await setLevel(ORG_A, 'read');
    expect((await admin.query(`SELECT details FROM platform_audit WHERE action = 'client.agency_access_changed'`)).rows[0].details).toMatchObject({ from: 'admin', to: 'read' });
  });
});

describe('empresa con la prueba vencida', () => {
  async function expireTrial(orgId: string, owner: string) {
    await admin.query(`INSERT INTO trials(id, organization_id, owner_user_id, started_at, ends_at, status, expired_at) VALUES (gen_random_uuid(),$1,$2, now() - interval '12 days', now() - interval '5 days', 'expired', now() - interval '5 days')`, [orgId, owner]);
  }

  it('la agencia y el Súper Admin entran en SOLO LECTURA a una empresa con la prueba vencida (no en pausa)', async () => {
    await assign(ORG_A, AG1);
    await expireTrial(ORG_A, IDS.alice);
    const dave = await login('dave@agencia1.test');
    expect(await json<Me>(await sw(dave, ORG_A))).toMatchObject({ acting_as: 'agency', access_level: 'admin', read_only: true });
    expect((await call('GET', '/trials/me', dave)).status).toBe(200);
    expect((await call('POST', '/trials/me/extension', dave, { reason: 'x'.repeat(12) })).status).toBe(403); // sin escritura aunque sea administrador

    expect(await json<Me>(await sw(rootToken, ORG_A))).toMatchObject({ acting_as: 'super_admin', read_only: true });
    expect((await call('POST', '/trials/me/extension', rootToken, { reason: 'x'.repeat(12) })).status).toBe(403);
  });
});

describe('el Súper Admin en soporte', () => {
  it('entra a cualquier empresa o agencia SIN membresía, actúa como administrador de ahí y vuelve a la plataforma', async () => {
    expect(await json<Me>(await sw(rootToken, ORG_A))).toMatchObject({ organization: { id: ORG_A, kind: 'client' }, role: 'super_admin', acting_as: 'super_admin', home: { id: IDS.platformOrg, kind: 'platform' }, read_only: false });
    expect((await admin.query(`SELECT count(*)::int AS n FROM organization_members WHERE user_id = $1 AND organization_id = $2`, [IDS.root, ORG_A])).rows[0].n).toBe(0); // no se fabrica una membresía
    expect((await call('GET', '/platform/companies', rootToken)).status).toBe(403); // dentro de una empresa NO es la consola de plataforma
    expect((await call('POST', '/trials/me/extension', rootToken, { reason: 'Soporte técnico para la empresa' })).status).not.toBe(403);

    expect(await json<Me>(await sw(rootToken, AG1))).toMatchObject({ organization: { id: AG1, kind: 'agency' }, acting_as: 'super_admin' });
    expect((await call('GET', '/agency/clients', rootToken)).status).toBe(200); // en una agencia ve su consola «Mis clientes»

    expect(await json<Me>(await sw(rootToken, null))).toMatchObject({ organization: { id: IDS.platformOrg, kind: 'platform' }, acting_as: null });
    expect((await call('GET', '/platform/companies', rootToken)).status).toBe(200);
    expect((await sw(rootToken, IDS.platformOrg)).status).toBe(200); // «entrar» a la plataforma es volver a casa
  });

  it('solo el Súper Admin VIGENTE: si pierde su rol en la plataforma, la sesión abierta en una empresa deja de valer al instante', async () => {
    await sw(rootToken, ORG_A);
    expect((await me(rootToken)).organization.id).toBe(ORG_A);
    await admin.query(`UPDATE organization_members SET revoked_at = now() WHERE user_id = $1`, [IDS.root]);
    expect((await call('GET', '/auth/me', rootToken)).status).toBe(401);
  });

  it('una empresa suspendida, una agencia no existente o un destino borrado: 404', async () => {
    await admin.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ORG_B]);
    expect((await sw(rootToken, ORG_B)).status).toBe(404);
    expect((await sw(rootToken, NOBODY)).status).toBe(404);
  });
});

describe('selector de contexto', () => {
  it('lista los clientes a los que la persona puede entrar (cartera), con búsqueda, sin el contexto actual ni clientes ajenos', async () => {
    await assign(ORG_A, AG1);
    await assign(ORG_C, AG1);
    await assign(ORG_B, AG2);
    const dave = await login('dave@agencia1.test');
    const names = async (qs = '') => (await json<{ items: Array<{ id: string; name: string; role: string; access_level: string | null }> }>(await call('GET', `/context/options${qs}`, dave))).items.map((i) => i.name);
    expect(await names()).toEqual(['Barbería Norte', 'Café Origen']);
    expect(await names('?q=caf')).toEqual(['Café Origen']);
    expect(await names('?q=%25')).toEqual([]); // el % se busca literal
    await sw(dave, ORG_A);
    expect(await names()).toEqual(['Café Origen']); // el contexto actual no se ofrece
    const frank = await login('frank@agencia2.test');
    expect((await json<{ items: Array<{ name: string }> }>(await call('GET', '/context/options', frank))).items.map((i) => i.name)).toEqual(['Estudio Luna']);
    expect((await json<{ items: unknown[] }>(await call('GET', '/context/options', rootToken))).items).toEqual([]);
    expect((await call('GET', '/context/options?extra=1', dave)).status).toBe(400);
  });
});

describe('«Mis clientes» de la agencia', () => {
  it('muestra SOLO la cartera de la agencia del contexto (A↔B): ni los clientes de otra agencia ni los de administración directa', async () => {
    await assign(ORG_A, AG1);
    await assign(ORG_B, AG2);
    const dave = await login('dave@agencia1.test');
    const eva = await login('eva@agencia1.test');
    const frank = await login('frank@agencia2.test');
    expect((await myClients(dave)).items.map((c) => c.id)).toEqual([ORG_A]);
    expect((await myClients(eva)).items.map((c) => c.id)).toEqual([ORG_A]); // la misma cartera para todas las personas de la agencia
    expect((await myClients(frank)).items.map((c) => c.id)).toEqual([ORG_B]);
    expect(await myClients(dave)).toMatchObject({ items: [{ name: 'Barbería Norte', kind: 'client', state: 'active', agency: { id: AG1 }, agency_access_level: 'admin' }], next_cursor: null });
  });

  it('no admite filtros que salgan de la cartera: agency, kind, plan y campos desconocidos → 400', async () => {
    const dave = await login('dave@agencia1.test');
    for (const qs of [`?agency=${AG2}`, '?agency=none', '?kind=agency', '?plan=none', '?organization_id=' + ORG_B]) expect((await call('GET', `/agency/clients${qs}`, dave)).status, qs).toBe(400);
  });

  it('busca, filtra por estado y pagina', async () => {
    await assign(ORG_A, AG1);
    await assign(ORG_B, AG1);
    await assign(ORG_C, AG1);
    const dave = await login('dave@agencia1.test');
    expect((await myClients(dave, '?q=luna')).items.map((c) => c.id)).toEqual([ORG_B]);
    const p1 = await myClients(dave, '?limit=2');
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await myClients(dave, `?limit=2&cursor=${p1.next_cursor}`);
    expect(p2.items).toHaveLength(1);
    expect([...p1.items, ...p2.items].map((c) => c.id).sort()).toEqual([ORG_A, ORG_B, ORG_C].sort());
    expect((await myClients(dave, '?state=invited')).items).toEqual([]);
  });
});

describe('«Registrar cliente»', () => {
  const body = { name: 'Gimnasio Sol', owner_email: 'dueno@gimnasio.test', timezone: 'America/Guayaquil', country: 'EC' };
  const register = (t: string, b: unknown = body) => call('POST', '/agency/clients', t, b);

  it('crea el cliente en LA cartera de la agencia del contexto, con acceso para su personal, historial, auditoría e invitación al dueño', async () => {
    const dave = await login('dave@agencia1.test');
    const r = await register(dave);
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const out = await json<{ company: { id: string; kind: string; state: string; plan: unknown }; invitation: { delivery: string; invite_url?: string } }>(r);
    expect(out.company).toMatchObject({ kind: 'client', state: 'invited', plan: null });
    expect(out.invitation.delivery).toBe('sent');
    expect(out.invitation.invite_url).toBeUndefined(); // el enlace solo se devuelve si el correo NO salió

    const org = (await admin.query(`SELECT parent_agency_id, created_by_agency_id, plan_id, kind, country FROM organizations WHERE id = $1`, [out.company.id])).rows[0];
    expect(org).toMatchObject({ parent_agency_id: AG1, created_by_agency_id: AG1, plan_id: null, kind: 'client', country: 'EC' });
    expect((await admin.query(`SELECT u.email, m.access_level FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND m.role = 'agency' AND m.revoked_at IS NULL ORDER BY u.email`, [out.company.id])).rows).toEqual([
      { email: 'dave@agencia1.test', access_level: 'admin' },
      { email: 'eva@agencia1.test', access_level: 'admin' },
    ]);
    expect((await admin.query(`SELECT from_agency_id, to_agency_id, reason, notify_client FROM organization_ownership_history WHERE organization_id = $1`, [out.company.id])).rows).toEqual([{ from_agency_id: null, to_agency_id: AG1, reason: 'Registrado por la agencia', notify_client: false }]);
    const audit = (await admin.query(`SELECT organization_id, entity_type, entity_id, acting_as, actor_user_id FROM audit_logs WHERE entity_id = $1`, [out.company.id])).rows;
    expect(audit).toEqual([{ organization_id: AG1, entity_type: 'organization', entity_id: out.company.id, acting_as: null, actor_user_id: IDS.dave }]);
    expect(mail.inviteOutbox).toHaveLength(1);
    expect(mail.inviteOutbox[0]).toMatchObject({ to: 'dueno@gimnasio.test', kind: 'client' });

    // La consola de plataforma lo ve «invitado», con el correo del DUEÑO invitado (no el de la agencia) y sin contar al personal de la agencia como miembros
    const listed = (await json<{ items: Array<{ state: string; owner_email: string | null; users: number; agency: { id: string } | null }> }>(await call('GET', '/platform/companies?q=Gimnasio', rootToken))).items;
    expect(listed).toMatchObject([{ state: 'invited', owner_email: 'dueno@gimnasio.test', users: 0, agency: { id: AG1 } }]);
    // aparece en «Mis clientes» como invitación pendiente, y la agencia puede entrar
    expect((await myClients(dave)).items).toMatchObject([{ id: out.company.id, state: 'invited', invitation: { email: 'dueno@gimnasio.test' } }]);
    expect(await json<Me>(await sw(dave, out.company.id))).toMatchObject({ acting_as: 'agency', access_level: 'admin' });
    // la otra agencia no lo ve ni entra
    const frank = await login('frank@agencia2.test');
    expect((await myClients(frank)).items).toEqual([]);
    expect((await sw(frank, out.company.id)).status).toBe(404);
  });

  it('el dueño acepta la invitación: queda como administrador del cliente, empieza su prueba y la agencia conserva el acceso', async () => {
    const dave = await login('dave@agencia1.test');
    const out = await json<{ company: { id: string } }>(await register(dave));
    const token = tokenOf(mail.inviteOutbox[0]!.inviteUrl);
    const acc = await call('POST', '/auth/invitations/accept', undefined, { token, password: 'Clave-Del-Dueno-1', full_name: 'Dueño Gimnasio', phone: '+593987654321' });
    expect(acc.status).toBe(200);
    expect((await admin.query(`SELECT role FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'dueno@gimnasio.test' AND m.organization_id = $1`, [out.company.id])).rows).toEqual([{ role: 'client_admin' }]);
    expect((await admin.query(`SELECT status FROM trials WHERE organization_id = $1`, [out.company.id])).rows).toEqual([{ status: 'active' }]);
    expect((await myClients(dave)).items[0]).toMatchObject({ id: out.company.id, state: 'trial', invitation: null });
    expect((await sw(dave, out.company.id)).status).toBe(200);
  });

  it('no se puede forjar la cartera ni el plan: parent_agency_id, created_by_agency_id, plan_id, kind y campos extra → 400', async () => {
    const dave = await login('dave@agencia1.test');
    for (const extra of [{ parent_agency_id: AG2 }, { created_by_agency_id: AG2 }, { plan_id: null }, { kind: 'agency' }, { organization_id: ORG_B }, { agency_id: AG2 }]) {
      expect((await register(dave, { ...body, ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    for (const bad of [{ ...body, country: 'ZZ' }, { ...body, owner_email: 'no-es-correo' }, { ...body, timezone: 'Marte/Olimpo' }, { ...body, name: 'x' }]) expect((await register(dave, bad)).status).toBe(400);
    expect((await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(6);
  });

  it('cuando el correo no sale, la agencia recibe el enlace para entregarlo por otro medio', async () => {
    const dave = await login('dave@agencia1.test');
    mail.failNext = true;
    const out = await json<{ invitation: { delivery: string; invite_url?: string } }>(await register(dave));
    expect(out.invitation.delivery).toBe('failed');
    expect(out.invitation.invite_url).toMatch(/^https:\/\/app\.ejemplo\.test\/accept-invite#token=/);
  });

  it('reenviar la invitación: solo a clientes de la cartera propia (un cliente ajeno es 404) y respetando la espera', async () => {
    await assign(ORG_B, AG2);
    const dave = await login('dave@agencia1.test');
    const { company } = await json<{ company: { id: string } }>(await register(dave));
    expect((await call('POST', `/agency/clients/${company.id}/invitation/resend`, dave)).status).toBe(429); // recién enviada
    await admin.query(`UPDATE invitations SET last_sent_at = now() - interval '1 hour' WHERE organization_id = $1`, [company.id]);
    const r = await call('POST', `/agency/clients/${company.id}/invitation/resend`, dave);
    expect(r.status).toBe(200);
    expect(await json<{ delivery: string }>(r)).toMatchObject({ delivery: 'sent' });
    expect(mail.inviteOutbox).toHaveLength(2);

    const frank = await login('frank@agencia2.test');
    expect((await call('POST', `/agency/clients/${company.id}/invitation/resend`, frank)).status).toBe(404); // cliente de otra agencia
    expect((await call('POST', `/agency/clients/${ORG_B}/invitation/resend`, dave)).status).toBe(404); // cliente de otra agencia
    expect((await call('POST', `/agency/clients/${ORG_C}/invitation/resend`, dave)).status).toBe(404); // administración directa
    expect((await call('POST', `/agency/clients/${NOBODY}/invitation/resend`, dave)).status).toBe(404);
    expect((await call('POST', `/agency/clients/${AG1}/invitation/resend`, dave)).status).toBe(404); // su propia agencia
  });

  it('una agencia suspendida no registra clientes (su sesión ya no vale)', async () => {
    const dave = await login('dave@agencia1.test');
    await call('POST', `/platform/agencies/${AG1}/suspend`, rootToken);
    expect((await register(dave)).status).toBe(401);
  });
});

describe('marca «actuando como» en la auditoría del cliente', () => {
  const changePassword = (t: string, current: string, next: string) => call('POST', '/auth/password', t, { current_password: current, new_password: next });
  const auditRows = async (orgId: string) => (await admin.query(`SELECT actor_user_id, acting_as, acting_org_id, entity_type, field FROM audit_logs WHERE organization_id = $1 ORDER BY at`, [orgId])).rows;

  it('lo hecho por la agencia dentro del cliente queda en la auditoría DEL CLIENTE con acting_as=agency y la agencia de origen', async () => {
    await assign(ORG_A, AG1);
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    expect((await changePassword(dave, PW, 'Otra-Clave-2026-x')).status).toBe(204);
    expect(await auditRows(ORG_A)).toEqual([{ actor_user_id: IDS.dave, acting_as: 'agency', acting_org_id: AG1, entity_type: 'user', field: 'password' }]);
  });

  it('el Súper Admin en soporte deja acting_as=super_admin con la plataforma de origen; el propio cliente no lleva marca', async () => {
    await sw(rootToken, ORG_A);
    expect((await changePassword(rootToken, PW, 'Otra-Clave-2026-y')).status).toBe(204);
    const alice = await login('alice@a.test');
    expect((await changePassword(alice, PW, 'Otra-Clave-2026-z')).status).toBe(204);
    expect(await auditRows(ORG_A)).toEqual([
      { actor_user_id: IDS.root, acting_as: 'super_admin', acting_org_id: IDS.platformOrg, entity_type: 'user', field: 'password' },
      { actor_user_id: IDS.alice, acting_as: null, acting_org_id: null, entity_type: 'user', field: 'password' },
    ]);
  });

  it('el contexto de la agencia en su propia organización no lleva marca', async () => {
    const dave = await login('dave@agencia1.test');
    expect((await changePassword(dave, PW, 'Otra-Clave-2026-w')).status).toBe(204);
    expect(await auditRows(AG1)).toEqual([{ actor_user_id: IDS.dave, acting_as: null, acting_org_id: null, entity_type: 'user', field: 'password' }]);
  });
});

describe('historial de accesos (access_sessions)', () => {
  it('registra cada entrada de la agencia y del Súper Admin (quién, dónde, cuándo, cuánto) y se cierra al salir; solo lo lee el Súper Admin', async () => {
    await assign(ORG_A, AG1);
    await assign(ORG_C, AG1);
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    await sw(dave, ORG_C); // pasar de un cliente a otro cierra la primera entrada
    await sw(await login('root@plat.test'), ORG_B); // una sesión aparte: la que lista el historial se queda en la plataforma

    const all = (await accessList()).items;
    expect(all).toHaveLength(3);
    const byOrg = new Map(all.map((i) => [i.organization.id, i]));
    expect(byOrg.get(ORG_A)).toMatchObject({ actor: { email: 'dave@agencia1.test' }, actor_role: 'agency', organization: { name: 'Barbería Norte', kind: 'client' }, open: false, end_reason: 'switch' });
    expect(byOrg.get(ORG_C)).toMatchObject({ actor_role: 'agency', open: true, end_reason: null, ended_at: null });
    expect(byOrg.get(ORG_B)).toMatchObject({ actor: { email: 'root@plat.test' }, actor_role: 'super_admin', open: true });
    expect(byOrg.get(ORG_A)!.duration_seconds).toBeGreaterThanOrEqual(0);

    await sw(dave, null);
    expect((await accessList('?open=true')).items.map((i) => i.organization.id)).toEqual([ORG_B]);
    expect((await accessList()).items.find((i) => i.organization.id === ORG_C)).toMatchObject({ open: false, end_reason: 'return' });
    expect((await accessList('?actor_role=super_admin')).items.map((i) => i.organization.id)).toEqual([ORG_B]);
    expect((await accessList('?q=dave')).items).toHaveLength(2);
    expect((await accessList('?q=Estudio')).items.map((i) => i.organization.id)).toEqual([ORG_B]);
  });

  it('paginación por cursor sin repetir ni saltar filas; cursor inválido o filtros desconocidos → 400', async () => {
    await assign(ORG_A, AG1);
    await assign(ORG_C, AG1);
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    await sw(dave, ORG_C);
    await sw(dave, ORG_A);
    const p1 = await accessList('?limit=2');
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await accessList(`?limit=2&cursor=${p1.next_cursor}`);
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(3);
    for (const qs of ['?cursor=basura', '?cursor=' + Buffer.from('2026-01-01T00:00:00Z|no-uuid').toString('base64url'), '?actor_role=x', '?limit=0', '?foo=1']) {
      expect((await call('GET', `/platform/access-sessions${qs}`, rootToken)).status, qs).toBe(400);
    }
  });

  it('guarda un HMAC de la IP (nunca la IP en claro)', async () => {
    await assign(ORG_A, AG1);
    await sw(await login('dave@agencia1.test'), ORG_A);
    const row = (await admin.query(`SELECT ip_hash FROM access_sessions`)).rows[0] as { ip_hash: string | null };
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('127.0.0.1');
    expect(JSON.stringify(await accessList())).not.toContain(row.ip_hash);
  });

  it('una sesión que termina (cierre o vencimiento) cierra su entrada: la lista nunca muestra «dentro» a una sesión muerta, y la tarea de limpieza lo deja escrito', async () => {
    await assign(ORG_A, AG1);
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    expect((await accessList()).items[0]).toMatchObject({ open: true });
    await admin.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'logout' WHERE id = $1`, [sessionIdOf(dave)]);
    expect((await accessList()).items[0]).toMatchObject({ open: false, end_reason: 'session_ended' }); // deducido de la sesión, antes de la limpieza
    expect((await admin.query(`SELECT ended_at FROM access_sessions`)).rows[0].ended_at).toBeNull();
    expect(await app.get(IdentityCleanupJob, { strict: false }).closeDeadAccessSessions()).toBe(1);
    expect((await admin.query(`SELECT end_reason, ended_at IS NOT NULL AS closed FROM access_sessions`)).rows[0]).toEqual({ end_reason: 'session_ended', closed: true });
    expect(await app.get(IdentityCleanupJob, { strict: false }).closeDeadAccessSessions()).toBe(0); // idempotente
  });

  it('la historia sobrevive a la limpieza de sesiones (sin clave foránea a sessions)', async () => {
    await assign(ORG_A, AG1);
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    await admin.query(`UPDATE sessions SET revoked_at = now() - interval '9 days', revoke_reason = 'logout' WHERE id = $1`, [sessionIdOf(dave)]);
    await app.get(IdentityCleanupJob, { strict: false }).run();
    expect((await admin.query(`SELECT count(*)::int AS n FROM sessions`)).rows[0].n).toBe(1); // solo queda la de root
    expect((await admin.query(`SELECT count(*)::int AS n FROM sessions WHERE id = $1`, [sessionIdOf(dave)])).rows[0].n).toBe(0);
    expect((await accessList()).items).toMatchObject([{ actor_role: 'agency', open: false, end_reason: 'session_ended' }]);
  });
});

describe('roles de base de datos sobre access_sessions', () => {
  it('app_rw y app_platform NO ven ni tocan la tabla; app_identity solo lee, inserta y cierra (ended_at/end_reason): no borra ni reescribe', async () => {
    await assign(ORG_A, AG1);
    await sw(await login('dave@agencia1.test'), ORG_A);
    const as = async (url: string, sql: string) => {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        await c.query(sql);
      } finally {
        await c.end();
      }
    };
    for (const url of [info.rwUrl, info.platformUrl]) {
      for (const q of ['SELECT 1 FROM access_sessions', `UPDATE access_sessions SET ended_at = now()`, 'DELETE FROM access_sessions']) await expect(as(url, q), q).rejects.toThrow(/permission denied/);
    }
    await expect(as(info.identityUrl, 'SELECT id FROM access_sessions')).resolves.toBeUndefined();
    await expect(as(info.identityUrl, 'DELETE FROM access_sessions')).rejects.toThrow(/permission denied/);
    await expect(as(info.identityUrl, `UPDATE access_sessions SET actor_role = 'agency'`)).rejects.toThrow(/permission denied/);
    await expect(as(info.identityUrl, `UPDATE access_sessions SET organization_id = organization_id`)).rejects.toThrow(/permission denied/);
    await expect(as(info.identityUrl, `UPDATE access_sessions SET ended_at = now(), end_reason = 'switch'`)).resolves.toBeUndefined();
    // los hechos de la historia (restricciones): motivo de cierre válido y consistente
    await expect(as(info.adminDbUrl, `UPDATE access_sessions SET end_reason = 'otro'`)).rejects.toThrow(/access_sessions_end_reason_valid/);
    await expect(as(info.adminDbUrl, `UPDATE access_sessions SET ended_at = NULL`)).rejects.toThrow(/access_sessions_end_consistent/);
    await expect(as(info.adminDbUrl, `UPDATE access_sessions SET ended_at = started_at - interval '1 second'`)).rejects.toThrow(/access_sessions_end_consistent/);
  });
});
