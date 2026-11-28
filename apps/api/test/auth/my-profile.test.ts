// V25 · 25.2 — «Mi perfil». Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/me/profile
//   PATCH /v1/me/profile
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { MyProfileModule, PROFILE_CHANGES_PER_WINDOW } from '../../src/modules/my-profile';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, MyProfileModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  agencyOrg: '00000000-0000-4000-8000-0000000000a9',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A, sin nombre
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1', // Súper Admin
};
const PHONE = '+593987650000';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob' | 'dave' | 'root', string>;
const saved = { ...process.env };

async function start(): Promise<void> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE member_history, user_hours, audit_logs, platform_audit, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [IDS.agencyOrg, 'agency', 'Agencia Uno']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', null], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia.test', 'Dario Agencia'], [IDS.root, 'root@plat.test', 'Rita Root']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  await admin.query(`UPDATE organizations SET parent_agency_id = $2, agency_access_level = 'admin' WHERE id = $1`, [ORG_A, IDS.agencyOrg]);
  for (const [u, o, r, level] of [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, IDS.agencyOrg, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role,access_level) VALUES (gen_random_uuid(),$1,$2,$3,$4)`, [u, o, r, level]);
  }
}

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
interface Profile { email: string; full_name: string | null; phone: string | null; hours: unknown; time_zone: string | null; photo: boolean }
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const get = async (token: string): Promise<Profile> => {
  const r = await call('GET', '/me/profile', token);
  expect(r.status, await r.clone().text()).toBe(200);
  return json<Profile>(r);
};
const patch = (token: string, body: unknown) => call('PATCH', '/me/profile', token, body);
const history = () => admin.query(`SELECT organization_id, user_id, kind, before, after FROM member_history ORDER BY created_at`).then((r) => r.rows);
const audits = () => admin.query(`SELECT organization_id, entity_type, entity_id, new_value, actor_user_id FROM audit_logs ORDER BY at`).then((r) => r.rows);
const userRow = (id: string) => admin.query(`SELECT full_name, phone, email FROM users WHERE id = $1`, [id]).then((r) => r.rows[0]);

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
});
afterAll(async () => { await admin.end(); process.env = saved; });
// La aplicación se levanta de nuevo en cada caso: el límite de intentos vive en la memoria del proceso
beforeEach(async () => {
  if (app) await app.close();
  await start();
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia.test'), root: await login('root@plat.test') };
});
afterAll(async () => { await app.close(); });

describe('ver y editar mi perfil', () => {
  it('cada persona ve solo lo suyo, con cualquier rol; sin sesión 401', async () => {
    expect(await get(T.carol)).toEqual({ email: 'carol@a.test', full_name: null, phone: null, hours: null, time_zone: 'America/Guayaquil', photo: true });
    expect(await get(T.alice)).toMatchObject({ email: 'alice@a.test', full_name: 'Alicia Torres' });
    expect(await get(T.bob)).toMatchObject({ email: 'bob@b.test' });
    expect(await get(T.dave)).toMatchObject({ email: 'dave@agencia.test' });
    expect(await get(T.root)).toEqual({ email: 'root@plat.test', full_name: 'Rita Root', phone: null, hours: null, time_zone: null, photo: false });
    expect((await call('GET', '/me/profile')).status).toBe(401);
    expect((await call('PATCH', '/me/profile', undefined, { full_name: 'Nadie' })).status).toBe(401);
  });

  it('guardar nombre y teléfono: se ve al instante; la empresa audita solo los campos y la historia guarda el nombre, nunca el teléfono', async () => {
    const r = await patch(T.carol, { full_name: '  Carolina Vera ', phone: PHONE });
    expect(r.status).toBe(200);
    expect(await json<Profile>(r)).toMatchObject({ full_name: 'Carolina Vera', phone: PHONE });
    expect((await json<{ user: { full_name: string } }>(await call('GET', '/auth/me', T.carol))).user.full_name).toBe('Carolina Vera');
    expect(await audits()).toEqual([{ organization_id: ORG_A, entity_type: 'user.profile', entity_id: IDS.carol, new_value: { fields: ['full_name', 'phone'] }, actor_user_id: IDS.carol }]);
    expect(await history()).toEqual([{ organization_id: ORG_A, user_id: IDS.carol, kind: 'profile_updated', before: { name: null }, after: { fields: ['full_name', 'phone'], name: 'Carolina Vera' } }]);
    expect(JSON.stringify([await audits(), await history()])).not.toContain(PHONE);
  });

  it('cambiar solo el teléfono no deja historia de nombre; repetir lo mismo no deja nada', async () => {
    expect((await patch(T.alice, { phone: PHONE })).status).toBe(200);
    expect(await history()).toEqual([]);
    expect(await audits()).toHaveLength(1);
    expect((await patch(T.alice, { phone: PHONE, full_name: 'Alicia Torres' })).status).toBe(200);
    expect(await audits()).toHaveLength(1);
  });

  it('valida: nombre corto, teléfono mal formado o vacío, cuerpo vacío; ni el correo ni otra persona se pueden indicar', async () => {
    const bad = [{ full_name: 'a' }, { full_name: 'x'.repeat(101) }, { phone: '0987654321' }, { phone: '' }, { phone: null }, {}, { email: 'otro@a.test' }, { user_id: IDS.alice, full_name: 'Robo' }];
    for (const body of bad) expect((await patch(T.carol, body)).status, JSON.stringify(body)).toBe(400);
    expect(await userRow(IDS.carol)).toEqual({ full_name: null, phone: null, email: 'carol@a.test' });
    await patch(T.carol, { full_name: 'Carolina Vera' });
    expect(await userRow(IDS.alice)).toMatchObject({ full_name: 'Alicia Torres', phone: null });
  });

  it('la agencia dentro de un cliente: queda en la historia de SU agencia y nada en el cliente', async () => {
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    expect((await get(T.dave)).photo).toBe(false);
    expect((await patch(T.dave, { phone: PHONE })).status).toBe(200);
    expect(await history()).toEqual([{ organization_id: IDS.agencyOrg, user_id: IDS.dave, kind: 'profile_updated', before: null, after: { fields: ['phone'] } }]);
    expect((await audits()).filter((a) => a.entity_type === 'user.profile')).toEqual([]);
  });

  it('el Súper Admin en la Consola: auditoría de plataforma con los campos, sin el teléfono', async () => {
    expect((await patch(T.root, { phone: PHONE, full_name: 'Rita R.' })).status).toBe(200);
    const rows = (await admin.query(`SELECT action, entity_id, actor_user_id, details FROM platform_audit WHERE action = 'user.profile.update'`)).rows;
    expect(rows).toEqual([{ action: 'user.profile.update', entity_id: IDS.root, actor_user_id: IDS.root, details: { fields: ['full_name', 'phone'] } }]);
    expect(JSON.stringify(rows)).not.toContain(PHONE);
  });

  it('con la prueba vencida puede editarse; en «Ver como» no', async () => {
    await admin.query(`INSERT INTO trials(id, organization_id, owner_user_id, started_at, ends_at, status, expired_at) VALUES (gen_random_uuid(),$1,$2, now() - interval '12 days', now() - interval '5 days', 'expired', now() - interval '5 days')`, [ORG_A, IDS.alice]);
    expect((await patch(T.alice, { phone: PHONE })).status).toBe(200);
    await admin.query(`DELETE FROM trials`);
    expect((await call('POST', '/context/view-as', T.alice, { role: 'advisor' })).status).toBe(200);
    expect((await patch(T.alice, { full_name: 'No' })).status).toBe(403);
  });

  it('límite de cambios por persona: pasado el tope responde 429 sin afectar a otra', async () => {
    for (let i = 0; i < PROFILE_CHANGES_PER_WINDOW; i += 1) expect((await patch(T.carol, { full_name: `Nombre ${i}` })).status).toBe(200);
    const r = await patch(T.carol, { full_name: 'Otro más' });
    expect(r.status).toBe(429);
    expect((await patch(T.alice, { full_name: 'Alicia T.' })).status).toBe(200);
  });
});
