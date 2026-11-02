// M10.5 — «Ver como» (ADR-56 B4): mirar la aplicación como otro ROL, solo lectura y solo reducción. Rutas cubiertas (el registro de endpoints exige que este archivo las escriba tal cual):
//   POST /v1/context/view-as
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia AG1
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let rootToken = '';
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE view_as_log, access_sessions, sessions, auth_throttle, signup_attempts, trials, invitations, organization_ownership_history, member_permissions, member_history, contact_phones, contacts, audit_logs, platform_audit, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string]> = [[IDS.alice, 'alice@a.test'], [IDS.carol, 'carol@a.test'], [IDS.bob, 'bob@b.test'], [IDS.dave, 'dave@agencia1.test'], [IDS.root, 'root@plat.test']];
  for (const [id, email] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, hash]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.dave, AG1, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  // Dos contactos de A: uno de la administradora y otro de la asesora; y uno de B
  await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, 'De Alicia', $2), (gen_random_uuid(), $1, 'De Carolina', $3), (gen_random_uuid(), $4, 'De Beto', $5)`, [ORG_A, IDS.alice, IDS.carol, ORG_B, IDS.bob]);
}

interface Me { viewing_as: string | null; view_as_options: string[]; read_only: boolean; role: string; acting_as: string | null; organization: { id: string; kind: string } }
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const me = async (t: string): Promise<Me> => json<Me>(await call('GET', '/auth/me', t));
const viewAs = (t: string, role: string | null) => call('POST', '/context/view-as', t, { role });
const sw = (t: string, target: string | null) => call('POST', '/context/switch', t, { target });
const names = async (t: string): Promise<string[]> => (await json<{ items: Array<{ name: string }> }>(await call('GET', '/contacts', t))).items.map((c) => c.name).sort();
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const logRows = async () => (await admin.query(`SELECT viewed_role, end_reason, organization_id FROM view_as_log ORDER BY started_at, id`)).rows as Array<{ viewed_role: string; end_reason: string | null; organization_id: string }>;
const assign = (orgId: string, agencyId: string | null) => call('PUT', `/platform/organizations/${orgId}/agency`, rootToken, { agency_id: agencyId });
const setLevel = (orgId: string, level: string) => call('PUT', `/platform/organizations/${orgId}/agency-access`, rootToken, { level });

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  rootToken = await login('root@plat.test');
});

describe('quién puede elegir qué', () => {
  it('sin sesión 401; el asesor, la plataforma y una agencia en su casa no tienen nada que elegir (404 uniforme)', async () => {
    expect((await call('POST', '/context/view-as', undefined, { role: 'advisor' })).status).toBe(401);
    expect((await me(await login('carol@a.test'))).view_as_options).toEqual([]);
    expect((await me(rootToken)).view_as_options).toEqual([]);
    expect((await me(await login('dave@agencia1.test'))).view_as_options).toEqual([]);
    for (const [email, role] of [['carol@a.test', 'advisor'], ['carol@a.test', 'client_admin'], ['dave@agencia1.test', 'advisor'], ['root@plat.test', 'client_admin']]) {
      const r = await viewAs(await login(email!), role!);
      expect(r.status, `${email} → ${role}`).toBe(404);
    }
  });

  it('el administrador de la empresa puede ver como Asesor y solo como Asesor; un rol mayor o inexistente no se acepta', async () => {
    const t = await login('alice@a.test');
    expect((await me(t)).view_as_options).toEqual(['advisor']);
    expect((await viewAs(t, 'client_admin')).status).toBe(404);
    expect((await viewAs(t, 'agency')).status).toBe(404);
    expect((await viewAs(t, 'super_admin')).status).toBe(400);
    expect((await call('POST', '/context/view-as', t, {})).status).toBe(400);
    expect((await call('POST', '/context/view-as', t, { role: 'advisor', extra: 1 })).status).toBe(400);
    expect((await me(t)).viewing_as).toBeNull();
  });

  it('el Súper Admin: en una empresa, Administrador y Asesor; en una agencia, Agencia; en la plataforma, nada', async () => {
    expect((await sw(rootToken, ORG_A)).status).toBe(200);
    expect((await me(rootToken)).view_as_options).toEqual(['client_admin', 'advisor']);
    expect((await viewAs(rootToken, 'agency')).status).toBe(404);
    expect((await sw(rootToken, AG1)).status).toBe(200);
    expect((await me(rootToken)).view_as_options).toEqual(['agency']);
    expect((await viewAs(rootToken, 'advisor')).status).toBe(404);
    expect((await viewAs(rootToken, 'agency')).status).toBe(200);
  });

  it('la agencia dentro de un cliente, nunca más que su nivel de acceso: «asesor» solo Asesor; «administrador» y «lectura», ambos', async () => {
    await assign(ORG_A, AG1);
    const dave = await login('dave@agencia1.test');
    expect((await sw(dave, ORG_A)).status).toBe(200);
    for (const [level, expected] of [['advisor', ['advisor']], ['admin', ['client_admin', 'advisor']], ['read', ['client_admin', 'advisor']]] as Array<[string, string[]]>) {
      expect((await setLevel(ORG_A, level)).status, level).toBe(200);
      expect((await me(dave)).view_as_options, level).toEqual(expected);
    }
    await setLevel(ORG_A, 'advisor');
    expect((await viewAs(dave, 'client_admin')).status).toBe(404);
    expect((await viewAs(dave, 'advisor')).status).toBe(200);
  });
});

describe('efecto: solo reducción y solo lectura', () => {
  it('como Asesor, la administradora ve solo lo suyo (pierde «ver todo»), la sesión queda en solo lectura y la vista propia vuelve al salir', async () => {
    const t = await login('alice@a.test');
    expect(await names(t)).toEqual(['De Alicia', 'De Carolina']); // administradora: ve todo
    const r = await viewAs(t, 'advisor');
    expect(r.status).toBe(200);
    expect(await json<Me>(r)).toMatchObject({ viewing_as: 'advisor', read_only: true, role: 'client_admin' }); // el rol real no cambia
    expect(await names(t)).toEqual(['De Alicia']); // sin view_all: solo lo suyo
    expect((await me(t)).viewing_as).toBe('advisor'); // sobrevive a recargar: vive en la sesión
    const back = await viewAs(t, null);
    expect(await json<Me>(back)).toMatchObject({ viewing_as: null, read_only: false });
    expect(await names(t)).toEqual(['De Alicia', 'De Carolina']);
  });

  it('toda petición que cambia datos responde 403 VIEW_AS_READ_ONLY (también las que solo exportan); cambiar o dejar de ver como y cambiar de contexto siguen abiertos', async () => {
    const t = await login('alice@a.test');
    await viewAs(t, 'advisor');
    for (const [m, p, b] of [['POST', '/contacts', { name: 'Nuevo' }], ['POST', '/contacts/export', { scope: 'all' }], ['PATCH', `/contacts/${IDS.alice}`, { name: 'X' }], ['DELETE', `/contacts/${IDS.alice}`]] as Array<[string, string, unknown?]>) {
      const r = await call(m, p, t, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(await code(r), `${m} ${p}`).toBe('VIEW_AS_READ_ONLY');
    }
    expect(Number((await admin.query(`SELECT count(*) FROM contacts WHERE organization_id = $1`, [ORG_A])).rows[0].count)).toBe(2); // no se creó nada
    expect((await viewAs(t, 'advisor')).status).toBe(200); // volver a pedir lo mismo no falla
    expect((await sw(t, null)).status).toBe(200); // cambiar de contexto sigue abierto
    expect((await viewAs(t, null)).status).toBe(200);
    expect((await call('POST', '/contacts', t, { name: 'Nuevo' })).status).toBe(201); // fuera de «ver como» escribe con normalidad
  });

  it('los ajustes por persona de nadie amplían la vista: sale la plantilla BASE del rol visto, no los permisos de otra persona', async () => {
    const t = await login('alice@a.test');
    const carolPerm = await admin.query(`SELECT id FROM organization_members WHERE user_id = $1`, [IDS.carol]);
    await admin.query(`INSERT INTO member_permissions(id, membership_id, permission_key, effect) VALUES (gen_random_uuid(), $1, 'contacts.export', 'grant')`, [carolPerm.rows[0].id]);
    await viewAs(t, 'advisor');
    expect((await call('GET', '/contacts', t)).status).toBe(200);
    expect(await names(t)).toEqual(['De Alicia']);
  });

  it('A↔B: la vista es de la sesión y de su empresa: otra sesión de la misma persona y las demás empresas no se afectan', async () => {
    const t1 = await login('alice@a.test');
    const t2 = await login('alice@a.test');
    await viewAs(t1, 'advisor');
    expect((await me(t2)).viewing_as).toBeNull();
    expect(await names(t2)).toEqual(['De Alicia', 'De Carolina']);
    const bob = await login('bob@b.test');
    expect((await me(bob)).viewing_as).toBeNull();
    expect(await names(bob)).toEqual(['De Beto']);
    expect((await logRows()).map((r) => r.organization_id)).toEqual([ORG_A]);
  });
});

describe('cortes y auditoría', () => {
  it('cambiar de contexto lo corta (el «ver como» no cruza a otra empresa) y cierra su registro; bajar el nivel de la agencia lo corta en la petición siguiente', async () => {
    await assign(ORG_A, AG1);
    await setLevel(ORG_A, 'admin');
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    expect((await viewAs(dave, 'client_admin')).status).toBe(200);
    expect(await me(dave)).toMatchObject({ viewing_as: 'client_admin', read_only: true });
    // el nivel baja a «asesor»: «ver como Administrador» ya no es un derecho → se corta SIN que nadie lo pida
    await setLevel(ORG_A, 'advisor');
    expect(await me(dave)).toMatchObject({ viewing_as: null, read_only: false, view_as_options: ['advisor'] });
    // y volver a la agencia lo cierra todo
    await setLevel(ORG_A, 'admin');
    expect((await viewAs(dave, 'advisor')).status).toBe(200);
    expect((await sw(dave, null)).status).toBe(200);
    expect(await me(dave)).toMatchObject({ viewing_as: null });
    const rows = await logRows();
    expect(rows.at(-1)).toMatchObject({ viewed_role: 'advisor', end_reason: 'switch' });
  });

  it('retirar el acceso de la agencia saca a la sesión (la validación de cada petición sigue mandando)', async () => {
    await assign(ORG_A, AG1);
    await setLevel(ORG_A, 'admin');
    const dave = await login('dave@agencia1.test');
    await sw(dave, ORG_A);
    await viewAs(dave, 'advisor');
    await assign(ORG_A, null);
    // La sesión vuelve a su origen (la agencia) y ya no mira nada; el registro se cierra
    expect(await me(dave)).toMatchObject({ viewing_as: null, read_only: false, acting_as: null, organization: { id: AG1 } });
    expect((await logRows()).at(-1)).toMatchObject({ viewed_role: 'advisor', end_reason: 'switch' });
  });

  it('cada cambio queda en view_as_log (quién, empresa, rol, motivo del cierre) y en la auditoría de la empresa con el actor real; repetir lo mismo no duplica; cerrar sesión lo cierra', async () => {
    const l = await json<{ access_token: string; refresh_token: string }>(await call('POST', '/auth/login', undefined, { email: 'alice@a.test', password: PW, token_transport: 'body' }));
    const t = l.access_token;
    await viewAs(t, 'advisor');
    await viewAs(t, 'advisor');
    await viewAs(t, null);
    await viewAs(t, 'advisor');
    expect(await logRows()).toEqual([
      { viewed_role: 'advisor', end_reason: 'cleared', organization_id: ORG_A },
      { viewed_role: 'advisor', end_reason: null, organization_id: ORG_A },
    ]);
    expect((await call('POST', '/auth/logout', undefined, { refresh_token: l.refresh_token })).status).toBe(204);
    expect((await logRows()).at(-1)).toMatchObject({ end_reason: 'logout' });
    const audit = (await admin.query(`SELECT actor_user_id AS user_id, old_value, new_value FROM audit_logs WHERE entity_type = 'view_as' ORDER BY at, id`)).rows as Array<{ user_id: string; old_value: unknown; new_value: unknown }>;
    expect(audit.map((a) => [a.old_value, a.new_value])).toEqual([[null, 'advisor'], ['advisor', null], [null, 'advisor']]);
    expect(audit.every((a) => a.user_id === IDS.alice)).toBe(true);
  });

  it('view_as_log no se puede reescribir ni borrar (solo se cierra) y la aplicación (app_rw) no la toca', async () => {
    const t = await login('alice@a.test');
    await viewAs(t, 'advisor');
    const ident = new Client({ connectionString: info.identityUrl });
    await ident.connect();
    const rw = new Client({ connectionString: info.rwUrl });
    await rw.connect();
    try {
      await expect(ident.query(`DELETE FROM view_as_log`)).rejects.toThrow(/permission denied/i);
      await expect(ident.query(`UPDATE view_as_log SET viewed_role = 'advisor'`)).rejects.toThrow(/permission denied/i);
      await expect(rw.query(`SELECT * FROM view_as_log`)).rejects.toThrow(/permission denied/i);
    } finally {
      await ident.end();
      await rw.end();
    }
  });
});
