// M5.1 — Conexiones de canales (ADR-50). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/channels
//   POST /v1/channels
//   PATCH /v1/channels/:id
//   POST /v1/channels/:id/check
//   DELETE /v1/channels/:id
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_UNAVAILABLE_ID, FAKE_UNKNOWN_PREFIX, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { OrganizationsModule } from '../../src/modules/organizations';
import { CredentialVault } from '../../src/modules/platform';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ChannelsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia (AG1), con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';
const KEY = randomBytes(32).toString('base64');
const TOKEN = FAKE_WHATSAPP_TOKEN;

interface Channel {
  id: string; provider: string; is_official: boolean; name: string; status: string; waba_id: string; phone_number_id: string; display_phone: string | null; verified_name: string | null;
  token_last4: string | null; last_check_at: string | null; last_error: string | null;
}
interface Listing { items: Channel[]; vault: { available: boolean } }
interface Err { error: { code: string; message: string } }

let admin: Client;
const apps: INestApplication[] = [];
let base = '';
let hash = '';
const saved = { ...process.env };

async function start(env: Record<string, string | undefined>): Promise<string> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake' });
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  delete process.env['DATABASE_URL_OWNER'];
  const app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return `${await app.getUrl()}/v1`;
}

async function seed() {
  await admin.query('TRUNCATE whatsapp_accounts, channel_accounts, channel_routes, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
  for (const [u, o, r, lv] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role,access_level) VALUES (gen_random_uuid(),$1,$2,$3,$4)`, [u, o, r, lv]);
}

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const callAt = (b: string, method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${b}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const call = (method: string, path: string, token?: string, body?: unknown) => callAt(base, method, path, token, body);
async function loginAt(b: string, email: string): Promise<string> {
  const r = await callAt(b, 'POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
let T: Record<'alice' | 'carol' | 'bob' | 'dave' | 'root', string>;
const code = async (r: Response): Promise<string> => (await json<Err>(r)).error.code;
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};
const body = (over: Record<string, unknown> = {}) => ({ name: 'WhatsApp Ventas', waba_id: '1234567890123', phone_number_id: '1090123456789', access_token: TOKEN, ...over });
const connect = async (t: string, over: Record<string, unknown> = {}): Promise<Channel> => ok<Channel>(await call('POST', '/channels', t, body(over)), 201);
const list = async (t: string): Promise<Listing> => ok<Listing>(await call('GET', '/channels', t));
const routeOf = async (phone: string) => (await admin.query('SELECT organization_id, channel_account_id, active FROM channel_routes WHERE phone_number_id = $1', [phone])).rows[0] as { organization_id: string; channel_account_id: string; active: boolean } | undefined;
const audits = async (entityId: string) => (await admin.query(`SELECT field, old_value, new_value FROM audit_logs WHERE entity_type = 'channel' AND entity_id = $1 ORDER BY at, id`, [entityId])).rows as Array<{ field: string | null; new_value: unknown }>;
const vault = CredentialVault.fromConfig({ current: { version: 1, key: KEY }, previous: undefined })!;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  base = await start({ PROVIDER_CREDENTIALS_KEY: KEY });
});
afterAll(async () => { for (const a of apps) await a.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await loginAt(base, 'alice@a.test'), carol: await loginAt(base, 'carol@a.test'), bob: await loginAt(base, 'bob@b.test'), dave: await loginAt(base, 'dave@agencia1.test'), root: await loginAt(base, 'root@plat.test') };
});

describe('permisos', () => {
  it('sin sesión 401 y la plataforma 403 en todas las rutas; el asesor no administra conexiones', async () => {
    const routes: Array<[string, string, unknown?]> = [['GET', '/channels'], ['POST', '/channels', body()], ['PATCH', `/channels/${NOBODY}`, { name: 'x' }], ['POST', `/channels/${NOBODY}/check`], ['DELETE', `/channels/${NOBODY}`]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
      expect((await call(m, p, T.carol, b)).status, `${m} ${p} asesor`).toBe(403);
    }
  });

  it('una agencia con nivel administrador puede; en «lectura» no (conectar o desconectar números no es una lectura)', async () => {
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    const c = await connect(T.dave);
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    for (const [m, p, b] of [['GET', '/channels'], ['POST', '/channels', body({ name: 'Otra', phone_number_id: '1090123456780' })], ['PATCH', `/channels/${c.id}`, { name: 'x' }], ['POST', `/channels/${c.id}/check`], ['DELETE', `/channels/${c.id}`]] as const) {
      expect((await call(m, p, T.dave, b)).status, `${m} ${p} lectura`).toBe(403);
    }
  });
});

describe('conectar un número', () => {
  it('guarda la conexión con los datos del proveedor; el token se cifra y no vuelve a salir; queda la ruta de identidad y la auditoría', async () => {
    expect((await list(T.alice))).toEqual({ items: [], vault: { available: true } });
    const r = await call('POST', '/channels', T.alice, body());
    const text = await r.text();
    expect(r.status).toBe(201);
    expect(text).not.toContain(TOKEN);
    const c = JSON.parse(text) as Channel;
    expect(c).toMatchObject({ provider: 'meta_cloud', is_official: true, name: 'WhatsApp Ventas', status: 'active', waba_id: '1234567890123', phone_number_id: '1090123456789', display_phone: '+1 555 6789', verified_name: 'Negocio de prueba', token_last4: 'oken', last_error: null });
    expect(c.last_check_at).not.toBeNull();
    expect(JSON.stringify(await list(T.alice))).not.toContain(TOKEN);

    const row = (await admin.query('SELECT credentials_sealed, key_version, token_last4 FROM channel_accounts WHERE id = $1', [c.id])).rows[0] as { credentials_sealed: string; key_version: number; token_last4: string };
    expect(row.credentials_sealed).not.toContain(TOKEN);
    expect(row.key_version).toBe(1);
    expect(vault.open(row.credentials_sealed, `channel/${c.id}`)).toEqual({ access_token: TOKEN });
    expect(() => vault.open(row.credentials_sealed, `channel/${NOBODY}`)).toThrow(); // atado a SU conexión: copiado a otra no abre
    expect(await routeOf('1090123456789')).toEqual({ organization_id: ORG_A, channel_account_id: c.id, active: true });
    const a = await audits(c.id);
    expect(a.map((x) => x.field)).toEqual([null]);
    expect(JSON.stringify(a)).not.toContain(TOKEN);
  });

  it('valida los datos antes de salir a Meta', async () => {
    const bad = async (over: Record<string, unknown>, label: string) => expect((await call('POST', '/channels', T.alice, body(over))).status, label).toBe(400);
    await bad({ name: '' }, 'sin nombre');
    await bad({ name: 'x'.repeat(61) }, 'nombre largo');
    await bad({ waba_id: 'abc' }, 'WABA con letras');
    await bad({ phone_number_id: '12' }, 'número muy corto');
    await bad({ phone_number_id: '1090/../2' }, 'id con ruta');
    await bad({ access_token: 'corto' }, 'token muy corto');
    await bad({ access_token: 'con espacios dentro del token' }, 'token con espacios');
    await bad({ otro: 1 }, 'campo desconocido');
    expect((await call('POST', '/channels', T.alice, { name: 'x' })).status).toBe(400);
    expect((await list(T.alice)).items).toEqual([]);
  });

  it('si el proveedor rechaza el token, el número o no responde, no se guarda nada y la respuesta lo explica', async () => {
    const wrongToken = await call('POST', '/channels', T.alice, body({ access_token: 'token-equivocado-123' }));
    expect(wrongToken.status).toBe(400);
    expect(await code(wrongToken)).toBe('CHANNEL_TOKEN_INVALID');
    const unknown = await call('POST', '/channels', T.alice, body({ phone_number_id: `${FAKE_UNKNOWN_PREFIX}77` }));
    expect(unknown.status).toBe(400);
    expect(await code(unknown)).toBe('CHANNEL_NUMBER_NOT_FOUND');
    const down = await call('POST', '/channels', T.alice, body({ phone_number_id: FAKE_UNAVAILABLE_ID }));
    expect(down.status).toBe(503);
    expect(await code(down)).toBe('CHANNEL_PROVIDER_UNAVAILABLE');
    expect((await list(T.alice)).items).toEqual([]);
    expect((await admin.query('SELECT count(*)::int AS n FROM channel_routes')).rows[0].n).toBe(0);
  });

  it('un nombre repetido se rechaza y no deja el número reservado; el mismo número no se conecta dos veces ni en otra empresa', async () => {
    await connect(T.alice);
    const dupName = await call('POST', '/channels', T.alice, body({ name: 'whatsapp ventas', phone_number_id: '1090123456780' }));
    expect(dupName.status).toBe(409);
    expect(await code(dupName)).toBe('CHANNEL_EXISTS');
    expect(await routeOf('1090123456780')).toMatchObject({ active: false }); // no quedó reservado
    expect((await call('POST', '/channels', T.alice, body({ name: 'Otro nombre', phone_number_id: '1090123456780' }))).status).toBe(201); // se puede conectar después

    const sameOrg = await call('POST', '/channels', T.alice, body({ name: 'Duplicado' }));
    expect(sameOrg.status).toBe(409);
    expect(await code(sameOrg)).toBe('CHANNEL_NUMBER_IN_USE');
    const otherOrg = await call('POST', '/channels', T.bob, body({ name: 'De Beto' }));
    expect(otherOrg.status).toBe(409);
    expect(await code(otherOrg)).toBe('CHANNEL_NUMBER_IN_USE');
    expect((await list(T.bob)).items).toEqual([]);
    expect((await routeOf('1090123456789'))!.organization_id).toBe(ORG_A);
  });

  it('dos conexiones simultáneas del mismo número: gana una', async () => {
    const results = await Promise.all([call('POST', '/channels', T.alice, body({ name: 'Uno' })), call('POST', '/channels', T.alice, body({ name: 'Dos' })), call('POST', '/channels', T.bob, body({ name: 'Tres' }))]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await admin.query('SELECT count(*)::int AS n FROM channel_routes')).rows[0].n).toBe(1);
    expect((await admin.query('SELECT count(*)::int AS n FROM whatsapp_accounts WHERE active')).rows[0].n).toBe(1);
  });

  it('hasta 10 conexiones por empresa', async () => {
    for (let i = 1; i <= 10; i++) await connect(T.alice, { name: `Línea ${i}`, phone_number_id: `10901234${String(50 + i).padStart(5, '0')}` });
    const over = await call('POST', '/channels', T.alice, body({ name: 'Línea 11', phone_number_id: '1090123499999' }));
    expect(over.status).toBe(409);
    expect(await code(over)).toBe('CHANNEL_LIMIT');
  });

  it('sin la clave maestra del servidor no se puede guardar nada (503), pero la lista avisa', async () => {
    const b = await start({});
    const token = await loginAt(b, 'alice@a.test');
    const r = await callAt(b, 'POST', '/channels', token, body());
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('CHANNEL_VAULT_UNAVAILABLE');
    expect((await json<Listing>(await callAt(b, 'GET', '/channels', token))).vault).toEqual({ available: false });
    expect((await admin.query('SELECT count(*)::int AS n FROM channel_routes')).rows[0].n).toBe(0);
  });
});

describe('cambiar una conexión', () => {
  it('renombra, desactiva y reactiva; un nombre repetido se rechaza; sin cambios es 400', async () => {
    const a = await connect(T.alice);
    const b = await connect(T.alice, { name: 'Soporte', phone_number_id: '1090123456780' });
    expect((await ok<Channel>(await call('PATCH', `/channels/${a.id}`, T.alice, { name: 'Ventas 2' }))).name).toBe('Ventas 2');
    expect(await code(await call('PATCH', `/channels/${b.id}`, T.alice, { name: 'VENTAS 2' }))).toBe('CHANNEL_EXISTS');
    expect((await ok<Channel>(await call('PATCH', `/channels/${a.id}`, T.alice, { status: 'disabled' }))).status).toBe('disabled');
    expect((await ok<Channel>(await call('PATCH', `/channels/${a.id}`, T.alice, { status: 'active' }))).status).toBe('active');
    expect((await call('PATCH', `/channels/${a.id}`, T.alice, {})).status).toBe(400);
    expect((await call('PATCH', `/channels/${a.id}`, T.alice, { status: 'otra' })).status).toBe(400);
    expect((await call('PATCH', `/channels/${NOBODY}`, T.alice, { name: 'x' })).status).toBe(404);
    expect((await audits(a.id)).map((x) => x.field)).toEqual([null, 'name', 'status', 'status']);
  });

  it('rotar el token lo comprueba antes: uno rechazado no cambia nada; uno válido reemplaza el cifrado y los últimos 4', async () => {
    const c = await connect(T.alice);
    const before = (await admin.query('SELECT credentials_sealed FROM channel_accounts WHERE id = $1', [c.id])).rows[0].credentials_sealed as string;
    const rejected = await call('PATCH', `/channels/${c.id}`, T.alice, { access_token: 'token-equivocado-123' });
    expect(rejected.status).toBe(400);
    expect(await code(rejected)).toBe('CHANNEL_TOKEN_INVALID');
    expect((await admin.query('SELECT credentials_sealed FROM channel_accounts WHERE id = $1', [c.id])).rows[0].credentials_sealed).toBe(before);
    const same = await ok<Channel>(await call('PATCH', `/channels/${c.id}`, T.alice, { access_token: TOKEN }));
    expect(same.token_last4).toBe('oken');
    const after = (await admin.query('SELECT credentials_sealed FROM channel_accounts WHERE id = $1', [c.id])).rows[0].credentials_sealed as string;
    expect(after).not.toBe(before); // se volvió a sellar
    expect(vault.open(after, `channel/${c.id}`)).toEqual({ access_token: TOKEN });
    expect((await audits(c.id)).at(-1)).toMatchObject({ field: 'token_rotated' });
    expect(JSON.stringify(await audits(c.id))).not.toContain(TOKEN);
  });
});

describe('comprobar la conexión', () => {
  it('con un token vigente actualiza los datos del número y la fecha de la comprobación', async () => {
    const c = await connect(T.alice);
    await admin.query(`UPDATE whatsapp_accounts SET display_phone = 'viejo', verified_name = NULL, last_check_at = '2020-01-01' WHERE channel_account_id = $1`, [c.id]);
    const r = await ok<Channel>(await call('POST', `/channels/${c.id}/check`, T.alice));
    expect(r).toMatchObject({ display_phone: '+1 555 6789', verified_name: 'Negocio de prueba', last_error: null });
    expect(new Date(r.last_check_at!).getFullYear()).toBeGreaterThan(2020);
  });

  it('si Meta ya no acepta el token, queda como último error de la conexión (no es un fallo de la petición) y se limpia al volver a servir', async () => {
    const c = await connect(T.alice);
    const revoked = vault.seal({ access_token: 'token-revocado-0000' }, `channel/${c.id}`);
    await admin.query('UPDATE channel_accounts SET credentials_sealed = $2 WHERE id = $1', [c.id, revoked.sealed]);
    const r = await ok<Channel>(await call('POST', `/channels/${c.id}/check`, T.alice));
    expect(r.last_error).toMatch(/rechazó el token/);
    expect((await list(T.alice)).items[0]!.last_error).toMatch(/rechazó el token/);
    const good = vault.seal({ access_token: TOKEN }, `channel/${c.id}`);
    await admin.query('UPDATE channel_accounts SET credentials_sealed = $2 WHERE id = $1', [c.id, good.sealed]);
    expect((await ok<Channel>(await call('POST', `/channels/${c.id}/check`, T.alice))).last_error).toBeNull();
    expect((await audits(c.id)).map((x) => x.field)).toEqual([null, 'health', 'health']);
  });

  it('un número que Meta ya no encuentra se informa igual; un sobre ilegible pide pegar el token otra vez; si Meta no responde es 503 sin cambios', async () => {
    const c = await connect(T.alice);
    await admin.query(`UPDATE whatsapp_accounts SET phone_number_id = $2 WHERE channel_account_id = $1`, [c.id, `${FAKE_UNKNOWN_PREFIX}55`]);
    expect((await ok<Channel>(await call('POST', `/channels/${c.id}/check`, T.alice))).last_error).toMatch(/no encontró este número/);

    await admin.query(`UPDATE whatsapp_accounts SET phone_number_id = $2, last_error = NULL WHERE channel_account_id = $1`, [c.id, FAKE_UNAVAILABLE_ID]);
    const down = await call('POST', `/channels/${c.id}/check`, T.alice);
    expect(down.status).toBe(503);
    expect(await code(down)).toBe('CHANNEL_PROVIDER_UNAVAILABLE');
    expect((await admin.query('SELECT last_error FROM whatsapp_accounts WHERE channel_account_id = $1', [c.id])).rows[0].last_error).toBeNull();

    await admin.query(`UPDATE channel_accounts SET credentials_sealed = 'ss1:1:basura:basura:basura:basura:basura:basura' WHERE id = $1`, [c.id]);
    const unreadable = await call('POST', `/channels/${c.id}/check`, T.alice);
    expect(unreadable.status).toBe(409);
    expect(await code(unreadable)).toBe('CHANNEL_CREDENTIALS_UNREADABLE');
    expect((await call('POST', `/channels/${NOBODY}/check`, T.alice)).status).toBe(404);
  });
});

describe('desconectar', () => {
  it('borrado lógico: desaparece de la lista, borra las credenciales, libera el número (que otra empresa puede tomar) y queda en la auditoría', async () => {
    const c = await connect(T.alice);
    await ok(await call('DELETE', `/channels/${c.id}`, T.alice));
    expect((await list(T.alice)).items).toEqual([]);
    const row = (await admin.query('SELECT deleted_at, credentials_sealed, token_last4 FROM channel_accounts WHERE id = $1', [c.id])).rows[0] as { deleted_at: Date | null; credentials_sealed: string | null; token_last4: string | null };
    expect(row.deleted_at).not.toBeNull();
    expect(row.credentials_sealed).toBeNull();
    expect(row.token_last4).toBeNull();
    expect(await routeOf('1090123456789')).toMatchObject({ active: false });
    expect((await call('DELETE', `/channels/${c.id}`, T.alice)).status).toBe(404);
    expect((await call('PATCH', `/channels/${c.id}`, T.alice, { name: 'x' })).status).toBe(404);
    expect((await audits(c.id)).map((x) => x.field)).toEqual([null, 'deleted']);
    // el número vuelve a estar disponible: en la misma empresa (con el nombre libre) y, si no, en otra
    const again = await connect(T.bob, { name: 'De Beto' });
    expect((await routeOf('1090123456789'))!.organization_id).toBe(ORG_B);
    expect(again.id).not.toBe(c.id);
    expect(await code(await call('POST', '/channels', T.alice, body({ name: 'Otra vez' })))).toBe('CHANNEL_NUMBER_IN_USE');
  });

  it('el nombre de una conexión borrada queda libre', async () => {
    const c = await connect(T.alice);
    await call('DELETE', `/channels/${c.id}`, T.alice);
    expect((await call('POST', '/channels', T.alice, body())).status).toBe(201);
  });
});

describe('aislamiento A↔B', () => {
  it('B no ve, cambia, comprueba ni desconecta las conexiones de A (404) y cada empresa lista solo las suyas', async () => {
    const a = await connect(T.alice);
    const b = await connect(T.bob, { name: 'De Beto', phone_number_id: '1090123456780' });
    expect((await list(T.alice)).items.map((c) => c.id)).toEqual([a.id]);
    expect((await list(T.bob)).items.map((c) => c.id)).toEqual([b.id]);
    for (const [m, p, bd] of [['PATCH', `/channels/${a.id}`, { name: 'Robada' }], ['POST', `/channels/${a.id}/check`], ['DELETE', `/channels/${a.id}`]] as const) {
      expect((await call(m, p, T.bob, bd)).status, `${m} ${p}`).toBe(404);
    }
    expect((await list(T.alice)).items[0]!.name).toBe('WhatsApp Ventas');
    expect((await routeOf('1090123456789'))!.active).toBe(true);
  });
});

describe('base de datos: privilegios y restricciones', () => {
  const as = async (url: string, sql: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await c.query(sql);
    } finally {
      await c.end();
    }
  };

  it('las tablas de negocio solo las toca app_rw (sin DELETE); la ruta de identidad solo app_identity (sin DELETE)', async () => {
    for (const t of ['channel_accounts', 'whatsapp_accounts']) {
      await expect(as(info.rwUrl, `DELETE FROM ${t}`), `DELETE ${t}`).rejects.toThrow(/permission denied/);
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), `TRUNCATE ${t}`).rejects.toThrow(/permission denied/);
      for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
    await expect(as(info.identityUrl, 'DELETE FROM channel_routes')).rejects.toThrow(/permission denied/);
    for (const url of [info.rwUrl, info.platformUrl]) await expect(as(url, 'SELECT 1 FROM channel_routes')).rejects.toThrow(/permission denied/);
  });

  it('las restricciones protegen la forma de los datos y las claves foráneas impiden cruzar empresas', async () => {
    const a = await connect(T.alice);
    const sql = (text: string) => admin.query(text);
    const acc = (cols: string, vals: string) => `INSERT INTO channel_accounts(organization_id, id, provider, name, ${cols}) VALUES ('${ORG_A}', gen_random_uuid(), 'meta_cloud', 'N ${Math.random()}', ${vals})`;
    await expect(sql(`INSERT INTO channel_accounts(organization_id, id, provider, name) VALUES ('${ORG_A}', gen_random_uuid(), 'sms', 'x')`)).rejects.toThrow(/channel_accounts_provider_valid/);
    await expect(sql(acc('status', `'rara'`))).rejects.toThrow(/channel_accounts_status_valid/);
    await expect(sql(`INSERT INTO channel_accounts(organization_id, id, provider, name) VALUES ('${ORG_A}', gen_random_uuid(), 'meta_cloud', '   ')`)).rejects.toThrow(/channel_accounts_name_shape/);
    await expect(sql(acc('credentials_sealed', `'x'`))).rejects.toThrow(/channel_accounts_credentials_pair/);
    await expect(sql(acc('token_last4', `'abc'`))).rejects.toThrow(/channel_accounts_last4_shape/);
    await expect(sql(`UPDATE channel_accounts SET name = 'whatsapp ventas' WHERE id <> '${a.id}'`)).resolves.toBeDefined(); // sin otras filas: no choca
    const wa = (org: string, ch: string, waba: string, phone: string) => `INSERT INTO whatsapp_accounts(organization_id, channel_account_id, waba_id, phone_number_id) VALUES ('${org}', '${ch}', '${waba}', '${phone}')`;
    await expect(sql(wa(ORG_A, a.id, '123456', '1090123456789'))).rejects.toThrow(/whatsapp_accounts_channel_uq|whatsapp_accounts_phone_active_uq/);
    await expect(sql(wa(ORG_B, a.id, '123456', '555555'))).rejects.toThrow(/whatsapp_accounts_channel_fk/); // conexión de otra empresa
    const b = await connect(T.bob, { name: 'B', phone_number_id: '1090123456780' });
    await expect(sql(`UPDATE whatsapp_accounts SET phone_number_id = 'abc' WHERE channel_account_id = '${b.id}'`)).rejects.toThrow(/whatsapp_accounts_phone_id_shape/);
    await expect(sql(`UPDATE whatsapp_accounts SET waba_id = '1' WHERE channel_account_id = '${b.id}'`)).rejects.toThrow(/whatsapp_accounts_waba_shape/);
    await expect(sql(`INSERT INTO channel_routes(phone_number_id, organization_id, channel_account_id) VALUES ('abc', '${ORG_A}', gen_random_uuid())`)).rejects.toThrow(/channel_routes_phone_id_shape/);
    await expect(sql(`INSERT INTO channel_routes(phone_number_id, organization_id, channel_account_id) VALUES ('1090123456789', '${ORG_B}', gen_random_uuid())`)).rejects.toThrow(/channel_routes_pkey/);
  });

  it('la RLS: sin organización activa app_rw no ve conexiones; con la de A no ve las de B', async () => {
    await connect(T.alice);
    await connect(T.bob, { name: 'B', phone_number_id: '1090123456780' });
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      for (const t of ['channel_accounts', 'whatsapp_accounts']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      for (const t of ['channel_accounts', 'whatsapp_accounts']) expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(1);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
