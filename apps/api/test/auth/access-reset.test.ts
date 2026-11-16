// ADR-71 (addendum v16) — restablecer el acceso de otra persona: el administrador del cliente, la agencia con nivel «admin» sobre su cartera y el Súper Admin. Rutas cubiertas
// (el registro de endpoints exige que este archivo las escriba tal cual):
//   GET /v1/users/:userId/reset-access
//   POST /v1/users/:userId/reset-access
//   POST /v1/platform/users/:userId/reset-access
//   GET /v1/platform/access-resets
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { MAIL_PROVIDER, MemoryMailProvider } from '../../src/mail';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const NEW_PW = 'Nueva-Clave-2026';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AG2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOBODY = '99999999-9999-4999-8999-999999999999';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A y su DUEÑA
  frank: 'f1000000-0000-4000-8000-0000000000f2', // segundo client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  eve: 'e0000000-0000-4000-8000-0000000000e5', // asesora de A
  hugo: '10000000-0000-4000-8000-000000000001', // asesor de A y de B (cuenta de varias empresas)
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B y su dueño
  gina: 'a9000000-0000-4000-8000-0000000000a9', // asesora de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agency (AG1)
  eva: 'e1000000-0000-4000-8000-0000000000e6', // agency (AG1, segunda persona)
  fran: 'f2000000-0000-4000-8000-0000000000f7', // agency (AG2)
  root: 'f0000000-0000-4000-8000-0000000000f1', // super_admin
  root2: 'f0000000-0000-4000-8000-0000000000f2', // otro super_admin
};
const EMAIL: Record<keyof typeof IDS, string> = {
  platformOrg: '', alice: 'alice@a.test', frank: 'frank@a.test', carol: 'carol@a.test', eve: 'eve@a.test', hugo: 'hugo@ab.test', bob: 'bob@b.test', gina: 'gina@b.test',
  dave: 'dave@agencia1.test', eva: 'eva@agencia1.test', fran: 'fran@agencia2.test', root: 'root@plat.test', root2: 'root2@plat.test',
};
let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let mail: MemoryMailProvider;
let rootToken = '';
const saved = { ...process.env };

async function start(mailProvider: string): Promise<INestApplication> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'INVITATION_ATTEMPT_IP_MAX_PER_HOUR']) delete process.env[k];
  Object.assign(process.env, {
    NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY,
    FRONTEND_BASE_URL: 'https://app.ejemplo.test', CAPTCHA_PROVIDER: 'fake', INVITATION_ATTEMPT_IP_MAX_PER_HOUR: '500',
    // límites chicos para poder probarlos
    ACCESS_RESET_ADMIN_MAX_PER_HOUR: '4', ACCESS_RESET_AGENCY_MAX_PER_HOUR: '2', ACCESS_RESET_SUPER_ADMIN_MAX_PER_HOUR: '4', ACCESS_RESET_TARGET_MAX_PER_HOUR: '3', ACCESS_RESET_AGENCY_ORG_MAX_PER_DAY: '5',
    ...(mailProvider === 'none' ? {} : { MAIL_PROVIDER: mailProvider }),
  });
  delete process.env['DATABASE_URL_OWNER'];
  const a = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(a);
  await a.listen(0, '127.0.0.1');
  return a;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE access_resets, access_sessions, member_history, sessions, auth_throttle, signup_attempts, password_resets, organization_members, organizations, users, platform_audit, audit_logs CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno'], [AG2, 'agency', 'Agencia Dos']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const names: Record<string, string> = { alice: 'Alicia Torres', frank: 'Francisco Paz', carol: 'Carolina Vera', eve: 'Eva Mora', hugo: 'Hugo Sosa', bob: 'Beto Luna', gina: 'Gina Ríos', dave: 'Daniel Vega', eva: 'Evelyn Cruz', fran: 'Fran Díaz', root: 'Raúl Root', root2: 'Rosa Root' };
  for (const [k, id] of Object.entries(IDS)) {
    if (k === 'platformOrg') continue;
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, EMAIL[k as keyof typeof IDS], hash, names[k]]);
  }
  const members: Array<[string, string, string]> = [
    [IDS.alice, ORG_A, 'client_admin'], [IDS.frank, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.hugo, ORG_A, 'advisor'], [IDS.hugo, ORG_B, 'advisor'],
    [IDS.bob, ORG_B, 'client_admin'], [IDS.gina, ORG_B, 'advisor'], [IDS.dave, AG1, 'agency'], [IDS.eva, AG1, 'agency'], [IDS.fran, AG2, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin'], [IDS.root2, IDS.platformOrg, 'super_admin'],
  ];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  await admin.query(`UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [IDS.alice, ORG_A]);
  await admin.query(`UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [IDS.bob, ORG_B]);
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const callAt = (root: string) => (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${root}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
let call = callAt('');
async function login(email: string, password = PW): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const loginStatus = async (email: string, password: string): Promise<number> => (await call('POST', '/auth/login', undefined, { email, password, token_transport: 'body' })).status;
const errOf = async (r: Response) => (await json<{ error: { code: string; message: string } }>(r)).error;
const tokenOf = (url: string): string => new URL(url).hash.replace(/^#token=/, '');
const assign = (orgId: string, agencyId: string | null) => call('PUT', `/platform/organizations/${orgId}/agency`, rootToken, { agency_id: agencyId });
const setLevel = (orgId: string, level: string) => call('PUT', `/platform/organizations/${orgId}/agency-access`, rootToken, { level });
const sw = (t: string, target: string | null) => call('POST', '/context/switch', t, { target });
const REASON = 'La persona perdió el teléfono con la sesión abierta';

interface Result { user_id: string; sessions_revoked: number; email_hint: string; mail_sent: boolean; notified: number }
const reset = (token: string, userId: string, body: Record<string, unknown> = {}) => call('POST', `/users/${userId}/reset-access`, token, { current_password: PW, ...body });
const platReset = (userId: string, body: Record<string, unknown> = {}, token = rootToken) => call('POST', `/platform/users/${userId}/reset-access`, token, { current_password: PW, ...body });
const resets = async () => (await admin.query(`SELECT * FROM access_resets ORDER BY created_at, id`)).rows as Array<Record<string, unknown>>;
const pending = async (id: string): Promise<boolean> => (await admin.query(`SELECT access_reset_pending_at IS NOT NULL AS p FROM users WHERE id = $1`, [id])).rows[0].p as boolean;
const hist = async (org: string) => (await admin.query(`SELECT kind, user_id, after FROM member_history WHERE organization_id = $1 AND kind = 'access_reset' ORDER BY created_at, id`, [org])).rows as Array<{ kind: string; user_id: string; after: { reason: string | null; by: string } }>;
const audits = async (userId: string) => (await admin.query(`SELECT acting_as, acting_org_id, new_value FROM audit_logs WHERE entity_type = 'user' AND entity_id = $1 AND field = 'access_reset'`, [userId])).rows as Array<{ acting_as: string | null; acting_org_id: string | null; new_value: { reason: string | null; sessions_revoked: number } }>;
const loggedUsers = ['alice', 'frank', 'carol', 'eve', 'hugo', 'bob', 'gina', 'dave', 'eva', 'fran', 'root', 'root2'] as const;
let T: Record<(typeof loggedUsers)[number], string>;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  app = await start('memory');
  base = `${await app.getUrl()}/v1`;
  call = callAt(base);
  mail = app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  mail.accessResetOutbox.length = 0;
  mail.accessResetNoticeOutbox.length = 0;
  T = Object.fromEntries(await Promise.all(loggedUsers.map(async (k) => [k, await login(EMAIL[k])]))) as typeof T;
  rootToken = T.root;
});

describe('acceso', () => {
  it('sin sesión 401; el asesor 403; la plataforma no entra por la ruta de empresa y el administrador del cliente no entra por las de plataforma', async () => {
    const routes: Array<[string, string, unknown?]> = [['POST', `/users/${IDS.eve}/reset-access`, { current_password: PW }], ['POST', `/platform/users/${IDS.eve}/reset-access`, { current_password: PW, reason: REASON }], ['GET', '/platform/access-resets']];
    for (const [m, p, b] of routes) expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
    expect((await reset(T.carol, IDS.eve)).status, 'asesora').toBe(403);
    expect((await reset(T.root, IDS.eve)).status, 'plataforma por la ruta de empresa').toBe(403);
    for (const [m, p, b] of routes.slice(1)) expect((await call(m, p, T.alice, b)).status, `${m} ${p} administrador del cliente`).toBe(403);
    expect((await call('GET', '/platform/access-resets', T.carol)).status).toBe(403);
    expect(await resets()).toEqual([]);
  });

  it('el permiso está protegido (no se puede quitar a un administrador) y no se le puede dar a un asesor', async () => {
    const { PROTECTED_FROM_DENY, isGrantable } = await import('../../src/rbac/permission-groups');
    expect(PROTECTED_FROM_DENY.has('users.reset_access')).toBe(true);
    expect(isGrantable('advisor', 'users.reset_access')).toBe(false);
    expect((await reset(T.carol, IDS.eve)).status).toBe(403);
  });
});

describe('el administrador del cliente', () => {
  it('restablece a una asesora: cierra sus sesiones, su contraseña vieja deja de servir y el enlace llega SOLO a su correo (y sirve una vez)', async () => {
    const r = await reset(T.alice, IDS.carol, { reason: REASON });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    const body = await json<Result>(r);
    expect(body).toMatchObject({ user_id: IDS.carol, sessions_revoked: 1, email_hint: 'ca***@a.test', mail_sent: true, notified: 0 });
    // el enlace NO viaja en la respuesta
    expect(JSON.stringify(body)).not.toMatch(/token|https?:/i);
    // su sesión abierta murió y su contraseña vieja ya no entra (mismo error que cualquier otro)
    expect((await call('GET', '/auth/me', T.carol)).status).toBe(401);
    expect(await loginStatus(EMAIL.carol, PW)).toBe(401);
    expect(await pending(IDS.carol)).toBe(true);
    // el correo: solo a ella, con quién lo pidió y el motivo
    expect(mail.accessResetOutbox).toHaveLength(1);
    const m = mail.lastAccessReset(EMAIL.carol)!;
    expect(m).toMatchObject({ actorLabel: 'El administrador Alicia Torres', organizationName: 'Barbería Norte', reason: REASON, expiresInMinutes: 60 });
    expect(m.resetUrl.startsWith('https://app.ejemplo.test/reset-password#token=')).toBe(true);
    expect(mail.accessResetNoticeOutbox).toEqual([]); // el administrador del cliente no avisa a los demás
    // el enlace sirve UNA vez y levanta el bloqueo
    const token = tokenOf(m.resetUrl);
    expect((await call('POST', '/auth/reset', undefined, { token, new_password: NEW_PW })).status).toBe(200);
    expect((await call('POST', '/auth/reset', undefined, { token, new_password: NEW_PW })).status).toBe(400);
    expect(await pending(IDS.carol)).toBe(false);
    expect(await loginStatus(EMAIL.carol, NEW_PW)).toBe(200);
  });

  it('deja registro: historia del equipo, auditoría de la empresa (sin enlace) y la tabla de restablecimientos; el motivo es opcional para el administrador', async () => {
    expect((await reset(T.alice, IDS.eve)).status).toBe(200); // sin motivo
    const h = await hist(ORG_A);
    expect(h).toEqual([{ kind: 'access_reset', user_id: IDS.eve, after: expect.objectContaining({ reason: null, by: 'client_admin' }) }]);
    const a = await audits(IDS.eve);
    expect(a).toHaveLength(1);
    expect(a[0]!.acting_as).toBeNull();
    expect(a[0]!.new_value).toMatchObject({ reason: null });
    const rows = await resets();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: IDS.alice, actor_role: 'client_admin', organization_id: ORG_A, target_user_id: IDS.eve, target_email_masked: 'ev***@a.test', mail_sent: true });
    expect(JSON.stringify(rows) + JSON.stringify(a)).not.toMatch(/#token=|\.[A-Za-z0-9_-]{40,}/);
  });

  it('puede con otro administrador, pero no con la dueña, ni consigo mismo, ni con un motivo de menos de 10 caracteres', async () => {
    // frank no es el dueño: él NO puede con la dueña; alice (dueña) sí puede con él
    const owner = await reset(T.frank, IDS.alice);
    expect(owner.status).toBe(403);
    expect((await errOf(owner)).code).toBe('RESET_NOT_ALLOWED');
    expect(await pending(IDS.alice)).toBe(false);
    expect((await reset(T.alice, IDS.frank, { reason: REASON })).status).toBe(200);
    const self = await reset(T.alice, IDS.alice);
    expect([self.status, (await errOf(self)).code]).toEqual([409, 'SELF_NOT_ALLOWED']);
    expect((await reset(T.alice, IDS.eve, { reason: 'corto' })).status).toBe(400);
    expect(await pending(IDS.eve)).toBe(false);
  });

  it('pide la contraseña PROPIA: con una mala no cambia nada y los fallos cuentan para el bloqueo del inicio de sesión', async () => {
    const bad = await reset(T.alice, IDS.carol, { current_password: 'otra-cosa-1234' });
    expect([bad.status, (await errOf(bad)).code]).toEqual([403, 'PASSWORD_INVALID']);
    expect(await pending(IDS.carol)).toBe(false);
    expect((await call('GET', '/auth/me', T.carol)).status).toBe(200);
    expect(await resets()).toEqual([]);
    // el fallo quedó anotado en el contador del inicio de sesión de quien actúa
    expect(((await admin.query(`SELECT count(*)::int AS n FROM auth_throttle WHERE failures > 0`)).rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it('una persona de otra empresa o inexistente es el MISMO 404 (A↔B) y no pasa nada', async () => {
    const other = await reset(T.alice, IDS.gina);
    const none = await reset(T.alice, NOBODY);
    expect([other.status, none.status]).toEqual([404, 404]);
    const [e1, e2] = [await errOf(other), await errOf(none)];
    expect([e1.code, e1.message]).toEqual([e2.code, e2.message]);
    expect((await reset(T.bob, IDS.carol)).status).toBe(404);
    expect(await pending(IDS.gina)).toBe(false);
    expect(await pending(IDS.carol)).toBe(false);
  });

  it('una cuenta de varias empresas NO se restablece por aquí (403 sin decir por qué) y no pasa nada', async () => {
    const r = await reset(T.alice, IDS.hugo);
    expect(r.status).toBe(403);
    expect(await errOf(r)).toMatchObject({ code: 'RESET_NOT_ALLOWED', message: 'Esta cuenta solo puede restablecerla la plataforma' });
    expect(await pending(IDS.hugo)).toBe(false);
    expect((await call('GET', '/auth/me', T.hugo)).status).toBe(200);
  });

  it('límites: por persona afectada (3 por hora) y por quien actúa (4 por hora)', async () => {
    for (let i = 0; i < 3; i += 1) expect((await reset(T.alice, IDS.carol)).status, `restablecimiento ${i + 1}`).toBe(200);
    const fourth = await reset(T.alice, IDS.carol);
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get('retry-after')).not.toBeNull();
    // el intento rechazado también cuenta para quien actúa (4 por hora): el siguiente, con otra persona, ya no pasa
    expect((await reset(T.alice, IDS.eve)).status).toBe(429);
    expect(await pending(IDS.eve)).toBe(false);
  });

  it('si el proveedor de correo falla, el restablecimiento ya está hecho: la respuesta lo dice y se puede repetir', async () => {
    mail.failNext = true;
    const r = await reset(T.alice, IDS.carol, { reason: REASON });
    expect(r.status).toBe(200);
    expect((await json<Result>(r)).mail_sent).toBe(false);
    expect(await pending(IDS.carol)).toBe(true);
    expect((await resets())[0]).toMatchObject({ mail_sent: false });
    expect((await reset(T.alice, IDS.carol, { reason: REASON })).status).toBe(200);
    expect(mail.accessResetOutbox).toHaveLength(1);
  });
});

describe('¿se puede restablecer?', () => {
  it('responde solo sí o no, sin decir por qué: sí con una asesora; no con la dueña (para otro administrador), consigo mismo, una cuenta de varias empresas, otra empresa o inexistente', async () => {
    const can = async (t: string, id: string): Promise<unknown> => json(await call('GET', `/users/${id}/reset-access`, t));
    expect(await can(T.alice, IDS.carol)).toEqual({ allowed: true });
    expect(await can(T.frank, IDS.alice)).toEqual({ allowed: false });
    expect(await can(T.alice, IDS.alice)).toEqual({ allowed: false });
    expect(await can(T.alice, IDS.hugo)).toEqual({ allowed: false });
    expect(await can(T.alice, IDS.gina)).toEqual({ allowed: false });
    expect(await can(T.alice, NOBODY)).toEqual({ allowed: false });
    expect((await call('GET', `/users/${IDS.carol}/reset-access`, T.eve)).status).toBe(403);
    expect((await call('GET', `/users/${IDS.carol}/reset-access`, T.root)).status).toBe(403);
    expect((await call('GET', `/users/${IDS.carol}/reset-access`)).status).toBe(401);
    expect(await pending(IDS.carol)).toBe(false);
  });
});

describe('la agencia', () => {
  async function inside(user: 'dave' | 'eva' | 'fran', org: string): Promise<string> {
    const r = await sw(T[user], org);
    expect(r.status, `${user} entra a ${org}`).toBe(200);
    return T[user];
  }

  it('con nivel «admin» y administrando al cliente: restablece a una asesora; exige motivo; avisa a la persona y a los administradores del cliente; y deja la marca «actuando como»', async () => {
    await assign(ORG_A, AG1);
    const d = await inside('dave', ORG_A);
    const noReason = await reset(d, IDS.carol);
    expect([noReason.status, (await errOf(noReason)).code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(await pending(IDS.carol)).toBe(false);
    const r = await reset(d, IDS.carol, { reason: 'El cliente pidió bloquear una cuenta comprometida' });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    expect(await json<Result>(r)).toMatchObject({ user_id: IDS.carol, mail_sent: true, notified: 2 });
    // a la persona, con quién lo pidió
    expect(mail.lastAccessReset(EMAIL.carol)).toMatchObject({ actorLabel: 'La agencia Agencia Uno', reason: 'El cliente pidió bloquear una cuenta comprometida' });
    // a los administradores del cliente, SIN enlace y con el motivo
    expect(mail.accessResetNoticeOutbox.map((n) => n.to).sort()).toEqual([EMAIL.alice, EMAIL.frank]);
    for (const n of mail.accessResetNoticeOutbox) {
      expect(n).toMatchObject({ actorLabel: 'La agencia Agencia Uno', targetName: 'Carolina Vera', organizationName: 'Barbería Norte', reason: 'El cliente pidió bloquear una cuenta comprometida' });
      expect(JSON.stringify(n)).not.toMatch(/token|https?:/i);
    }
    // auditoría del cliente con «actuando como» la agencia, historia del equipo y el registro del Súper Admin
    expect(await audits(IDS.carol)).toEqual([expect.objectContaining({ acting_as: 'agency', acting_org_id: AG1, new_value: expect.objectContaining({ reason: 'El cliente pidió bloquear una cuenta comprometida' }) })]);
    expect((await hist(ORG_A))[0]).toMatchObject({ user_id: IDS.carol, after: expect.objectContaining({ by: 'agency' }) });
    const rows = await resets();
    expect(rows[0]).toMatchObject({ actor_user_id: IDS.dave, actor_role: 'agency', actor_org_id: AG1, organization_id: ORG_A, target_user_id: IDS.carol });
  });

  it('puede con la dueña del cliente (política por omisión) y también con otro administrador', async () => {
    await assign(ORG_A, AG1);
    const d = await inside('dave', ORG_A);
    expect((await reset(d, IDS.alice, { reason: REASON })).status).toBe(200);
    expect(mail.lastAccessReset(EMAIL.alice)).toBeDefined();
    // alice (administradora) también recibe el aviso de la agencia sobre frank; a ella misma solo le llegó el enlace
    expect((await reset(d, IDS.frank, { reason: REASON })).status).toBe(200);
    expect(mail.accessResetNoticeOutbox.some((n) => n.to === EMAIL.alice && n.targetName === 'Francisco Paz')).toBe(true);
    expect(mail.accessResetNoticeOutbox.some((n) => n.to === EMAIL.alice && n.targetName === 'Alicia Torres')).toBe(false);
  });

  it('con nivel «lectura» o «asesor» es 403 y no pasa nada; al volver a «admin» sí puede', async () => {
    await assign(ORG_A, AG1);
    const d = await inside('dave', ORG_A);
    for (const level of ['read', 'advisor']) {
      expect((await setLevel(ORG_A, level)).status).toBe(200);
      const r = await reset(d, IDS.carol, { reason: REASON });
      expect(r.status, `nivel ${level}`).toBe(403);
      expect(await pending(IDS.carol)).toBe(false);
    }
    expect((await setLevel(ORG_A, 'admin')).status).toBe(200);
    expect((await reset(d, IDS.carol, { reason: REASON })).status).toBe(200);
  });

  it('sin cartera sobre la empresa no entra (404) y, dentro de la suya, no tiene el permiso; A↔B entre las carteras de dos agencias', async () => {
    await assign(ORG_A, AG1);
    await assign(ORG_B, AG2);
    // fran (AG2) no puede entrar a A, que es de AG1
    expect((await sw(T.fran, ORG_A)).status).toBe(404);
    // y dentro de su propia agencia (AG2) el permiso no existe
    expect((await reset(T.fran, IDS.carol, { reason: REASON })).status).toBe(403);
    // cada agencia solo alcanza a su cartera: dave (en A) no ve a la gente de B, fran (en B) no ve a la de A
    const d = await inside('dave', ORG_A);
    const f = await inside('fran', ORG_B);
    expect((await reset(d, IDS.gina, { reason: REASON })).status).toBe(404);
    expect((await reset(f, IDS.carol, { reason: REASON })).status).toBe(404);
    expect((await reset(f, IDS.gina, { reason: REASON })).status).toBe(200);
    expect(await pending(IDS.carol)).toBe(false);
    expect(await pending(IDS.gina)).toBe(true);
  });

  it('nunca sobre el personal de la agencia ni sobre cuentas de varias empresas: solo el Súper Admin', async () => {
    await assign(ORG_A, AG1);
    const d = await inside('dave', ORG_A);
    // eva es de la agencia: tiene una membresía por cliente (rol «agency»), no figura en el equipo del cliente
    expect((await reset(d, IDS.eva, { reason: REASON })).status).toBe(404);
    // hugo trabaja en dos empresas
    const multi = await reset(d, IDS.hugo, { reason: REASON });
    expect([multi.status, (await errOf(multi)).code]).toEqual([403, 'RESET_NOT_ALLOWED']);
    // y a sí mismo, tampoco
    expect((await reset(d, IDS.dave, { reason: REASON })).status).toBe(409);
    expect(await pending(IDS.eva)).toBe(false);
    expect(await pending(IDS.hugo)).toBe(false);
    expect(await resets()).toEqual([]);
  });

  it('con el dueño protegido por política: la agencia recibe 403 (parámetro ACCESS_RESET_AGENCY_CAN_RESET_OWNER)', async () => {
    const { companyVerdict } = await import('../../src/modules/auth/access-reset/access-reset.policy');
    expect(companyVerdict('agency', { roleHere: 'client_admin', activeMemberships: 1, isOwner: true }, false)).toEqual({ ok: false, reason: 'not_allowed' });
    expect(companyVerdict('agency', { roleHere: 'client_admin', activeMemberships: 1, isOwner: true }, true)).toEqual({ ok: true });
    expect(companyVerdict('client_admin', { roleHere: 'client_admin', activeMemberships: 1, isOwner: true }, true)).toEqual({ ok: false, reason: 'not_allowed' });
  });

  it('límites más estrictos: 2 por hora por persona de la agencia', async () => {
    await assign(ORG_A, AG1);
    const d = await inside('dave', ORG_A);
    expect((await reset(d, IDS.carol, { reason: REASON })).status).toBe(200);
    expect((await reset(d, IDS.eve, { reason: REASON })).status).toBe(200);
    const third = await reset(d, IDS.frank, { reason: REASON });
    expect(third.status).toBe(429);
    expect(await pending(IDS.frank)).toBe(false);
  });
});

describe('el Súper Admin (ruta de plataforma)', () => {
  it('restablece una cuenta de varias empresas: cierra todas sus sesiones, deja historia en cada empresa y avisa a los administradores de cada una', async () => {
    const r = await platReset(IDS.hugo, { reason: REASON });
    expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
    expect(await json<Result>(r)).toMatchObject({ user_id: IDS.hugo, mail_sent: true, notified: 3 });
    expect((await call('GET', '/auth/me', T.hugo)).status).toBe(401);
    expect(mail.lastAccessReset(EMAIL.hugo)).toMatchObject({ actorLabel: 'El equipo de la plataforma', organizationName: null, reason: REASON });
    expect(mail.accessResetNoticeOutbox.map((n) => n.to).sort()).toEqual([EMAIL.alice, EMAIL.bob, EMAIL.frank].sort());
    expect((await hist(ORG_A)).map((x) => x.user_id)).toEqual([IDS.hugo]);
    expect((await hist(ORG_B)).map((x) => x.user_id)).toEqual([IDS.hugo]);
    expect((await resets())[0]).toMatchObject({ actor_role: 'super_admin', organization_id: null, target_user_id: IDS.hugo });
    const pa = (await admin.query(`SELECT action, details FROM platform_audit WHERE entity_id = $1`, [IDS.hugo])).rows as Array<{ action: string; details: { organizations: number; reason: string } }>;
    expect(pa).toEqual([{ action: 'user.access_reset', details: expect.objectContaining({ organizations: 2, reason: REASON }) }]);
  });

  it('puede con el personal de la agencia y con otro Súper Admin, exige motivo y no puede consigo mismo', async () => {
    await assign(ORG_A, AG1);
    expect((await platReset(IDS.dave)).status).toBe(400); // sin motivo
    expect((await platReset(IDS.dave, { reason: REASON })).status).toBe(200);
    expect((await platReset(IDS.root2, { reason: REASON })).status).toBe(200);
    const self = await platReset(IDS.root, { reason: REASON });
    expect([self.status, (await errOf(self)).code]).toEqual([409, 'SELF_NOT_ALLOWED']);
    expect((await platReset(NOBODY, { reason: REASON })).status).toBe(404);
    expect((await platReset(IDS.eve, { reason: REASON, current_password: 'mala-clave-0000' })).status).toBe(403);
    expect(await pending(IDS.eve)).toBe(false);
  });

  it('el registro del Súper Admin lista quién, a quién, de qué empresa y por qué (correo enmascarado); se filtra por rol y por empresa; los demás reciben 403', async () => {
    expect((await reset(T.alice, IDS.carol)).status).toBe(200);
    expect((await platReset(IDS.hugo, { reason: REASON })).status).toBe(200);
    const all = await json<{ items: Array<{ actor_role: string; target: { email_hint: string; name: string | null }; reason: string | null; organization: { id: string } | null; actor: { email: string }; mail_sent: boolean }>; next_cursor: string | null }>(await call('GET', '/platform/access-resets', rootToken));
    expect(all.items.map((i) => [i.actor_role, i.target.email_hint, i.organization?.id ?? null])).toEqual([['super_admin', 'hu***@ab.test', null], ['client_admin', 'ca***@a.test', ORG_A]]);
    expect(all.items[0]).toMatchObject({ reason: REASON, actor: { email: EMAIL.root }, mail_sent: true });
    expect(JSON.stringify(all)).not.toMatch(/carol@a\.test|hugo@ab\.test/);
    const onlyAdmin = await json<{ items: unknown[] }>(await call('GET', '/platform/access-resets?actor_role=client_admin', rootToken));
    expect(onlyAdmin.items).toHaveLength(1);
    const byOrg = await json<{ items: unknown[] }>(await call('GET', `/platform/access-resets?organization_id=${ORG_A}`, rootToken));
    expect(byOrg.items).toHaveLength(1);
    const page = await json<{ items: unknown[]; next_cursor: string | null }>(await call('GET', '/platform/access-resets?limit=1', rootToken));
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).not.toBeNull();
    for (const t of [T.alice, T.eve, T.dave]) expect((await call('GET', '/platform/access-resets', t)).status).toBe(403);
  });
});

describe('sin servicio de correo', () => {
  it('no se restablece nada (503): no se puede dejar a alguien sin acceso sin poder avisarle', async () => {
    const other = await start('none');
    try {
      const otherCall = callAt(`${await other.getUrl()}/v1`);
      const lg = await otherCall('POST', '/auth/login', undefined, { email: EMAIL.alice, password: PW, token_transport: 'body' });
      const token = ((await lg.json()) as { access_token: string }).access_token;
      const r = await otherCall('POST', `/users/${IDS.carol}/reset-access`, token, { current_password: PW });
      expect([r.status, (await errOf(r)).code]).toEqual([503, 'ACCESS_RESET_UNAVAILABLE']);
      expect(await pending(IDS.carol)).toBe(false);
      expect(await resets()).toEqual([]);
    } finally {
      await other.close();
    }
  });
});
