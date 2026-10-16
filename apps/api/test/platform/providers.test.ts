// M2.6 — Proveedores de la plataforma (ADR-21, ADR-42). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   GET /v1/platform/providers · PUT /v1/platform/providers/:service/active
//   PUT /v1/platform/providers/:service/:provider/credentials · DELETE /v1/platform/providers/:service/:provider/credentials
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
import { OrganizationsModule } from '../../src/modules/organizations';
import { PROVIDER_CATALOG } from '../../src/modules/platform';
import { CredentialVault } from '../../src/modules/platform/providers/credential-vault';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // advisor de A
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agency (AG1)
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const KEY1 = randomBytes(32).toString('base64');
const KEY2 = randomBytes(32).toString('base64');
const SECRET = 'sk-live-ABCDEF1234567890cdef'; // un secreto de prueba reconocible: jamás debe aparecer en una respuesta ni en la auditoría
const SECRET2 = 'sk-live-ZYXWVU0987654321wxyz';

interface Field { key: string; masked: boolean; required: boolean; set: boolean; last4: string | null }
interface Prov { key: string; configured: boolean; fields: Field[]; updated_at: string | null }
interface Svc { key: string; managed: string; active: string | null; mode: string | null; providers: Prov[] }
interface List { vault: { available: boolean }; services: Svc[] }

let admin: Client;
const apps: INestApplication[] = [];
let base = '';
let hash = '';
let rootToken = '';
const saved = { ...process.env };

async function start(env: Record<string, string | undefined>): Promise<{ app: INestApplication; base: string }> {
  const keys = ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'PROVIDER_CREDENTIALS_KEY_VERSION', 'PROVIDER_CREDENTIALS_KEY_PREVIOUS', 'PROVIDER_CREDENTIALS_KEY_PREVIOUS_VERSION'];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake' });
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  delete process.env['DATABASE_URL_OWNER'];
  const app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return { app, base: `${await app.getUrl()}/v1` };
}

async function seed() {
  await admin.query('TRUNCATE sessions, auth_throttle, access_sessions, organization_members, organizations, users, platform_audit, provider_credentials, provider_selection CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [AG1, 'agency', 'Agencia Uno']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email] of [[IDS.alice, 'alice@a.test'], [IDS.carol, 'carol@a.test'], [IDS.dave, 'dave@agencia1.test'], [IDS.root, 'root@plat.test']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, hash]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.dave, AG1, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const callAt = (b: string, method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${b}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const call = (method: string, path: string, token?: string, body?: unknown) => callAt(base, method, path, token, body);
async function login(email: string, b = base): Promise<string> {
  const r = await callAt(b, 'POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const list = async (b = base, t = rootToken): Promise<List> => json<List>(await callAt(b, 'GET', '/platform/providers', t));
const svc = (l: List, key: string): Svc => l.services.find((s) => s.key === key)!;
const prov = (l: List, s: string, p: string): Prov => svc(l, s).providers.find((x) => x.key === p)!;
const field = (p: Prov, key: string): Field => p.fields.find((f) => f.key === key)!;
const save = (service: string, provider: string, body: unknown, b = base, t = rootToken) => callAt(b, 'PUT', `/platform/providers/${service}/${provider}/credentials`, t, body);
const activate = (service: string, provider: string | null, b = base, t = rootToken) => callAt(b, 'PUT', `/platform/providers/${service}/active`, t, { provider });
const clear = (service: string, provider: string, b = base, t = rootToken) => callAt(b, 'DELETE', `/platform/providers/${service}/${provider}/credentials`, t);
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const row = async (service: string, provider: string) => (await admin.query(`SELECT * FROM provider_credentials WHERE service = $1 AND provider = $2`, [service, provider])).rows[0] as { secrets_sealed: string | null; key_version: number | null; secret_hints: Record<string, string | null>; updated_by: string } | undefined;
const vault1 = CredentialVault.fromConfig({ current: { version: 1, key: KEY1 }, previous: undefined })!;
const audits = async (action?: string) => (await admin.query(`SELECT action, details, actor_user_id FROM platform_audit ${action ? 'WHERE action = $1' : ''} ORDER BY at, id`, action ? [action] : [])).rows as Array<{ action: string; details: Record<string, unknown>; actor_user_id: string }>;
/** Almacenamiento: TODOS sus datos (URL, región, bucket y claves) son credenciales: cifrados y solo se ven sus últimos 4. */
const S3 = { endpoint: 'https://s3.ejemplo.test', region: 'eu-west-1', bucket: 'ss-archivos', access_key_id: 'AKIAEXAMPLE000001', secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  base = (await start({ PROVIDER_CREDENTIALS_KEY: KEY1 })).base;
});
afterAll(async () => { for (const a of apps) await a.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  rootToken = await login('root@plat.test');
});

describe('acceso: solo el Súper Admin', () => {
  const routes = (): Array<[string, string, unknown?]> => [
    ['GET', '/platform/providers'],
    ['PUT', '/platform/providers/text_ai/active', { provider: 'openai' }],
    ['PUT', '/platform/providers/text_ai/openai/credentials', { values: { api_key: SECRET } }],
    ['DELETE', '/platform/providers/text_ai/openai/credentials'],
  ];

  it('sin sesión 401; cliente, asesor y agencia 403 en TODAS las rutas; no cambia nada', async () => {
    const tokens = [await login('alice@a.test'), await login('carol@a.test'), await login('dave@agencia1.test')];
    for (const [m, p, b] of routes()) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
      for (const t of tokens) expect((await call(m, p, t, b)).status, `${m} ${p}`).toBe(403);
    }
    expect((await admin.query(`SELECT (SELECT count(*) FROM provider_credentials)::int AS c, (SELECT count(*) FROM provider_selection)::int AS s, (SELECT count(*) FROM platform_audit)::int AS a`)).rows[0]).toEqual({ c: 0, s: 0, a: 0 });
  });

  it('el Súper Admin DENTRO de una empresa (soporte) tampoco: la consola de plataforma solo existe en la plataforma', async () => {
    expect((await call('POST', '/context/switch', rootToken, { target: ORG_A })).status).toBe(200);
    for (const [m, p, b] of routes()) expect((await call(m, p, rootToken, b)).status, `${m} ${p}`).toBe(403);
    expect((await admin.query(`SELECT count(*)::int AS n FROM provider_credentials`)).rows[0].n).toBe(0);
  });
});

describe('lista', () => {
  it('trae todo el catálogo con su estado; los servicios gestionados por el servidor muestran su modo; nada de caché', async () => {
    const r = await call('GET', '/platform/providers', rootToken);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const l = await json<List>(r);
    expect(l.vault).toEqual({ available: true });
    expect(l.services.map((s) => s.key)).toEqual(PROVIDER_CATALOG.map((s) => s.key));
    expect(svc(l, 'text_ai')).toMatchObject({ managed: 'platform', active: null });
    expect(svc(l, 'payments')).toMatchObject({ managed: 'platform', active: null, providers: [] });
    expect(svc(l, 'auth')).toMatchObject({ managed: 'fixed', active: 'local' });
    expect(svc(l, 'ghl')).toMatchObject({ managed: 'client' });
    expect(svc(l, 'mail')).toMatchObject({ managed: 'env', mode: 'memory', active: null });
    expect(svc(l, 'captcha')).toMatchObject({ managed: 'env', mode: 'fake', active: null });
    expect(prov(l, 'text_ai', 'openai')).toMatchObject({ configured: false, updated_at: null, fields: [{ key: 'api_key', masked: true, set: false, last4: null }] });
  });
});

describe('credenciales: todo cifrado, jamás devuelto (solo los últimos 4)', () => {
  it('guarda el valor cifrado, responde SIN él (solo últimos 4), lo deja en la BD sellado y se abre con la clave del servidor', async () => {
    const r = await save('text_ai', 'openai', { values: { api_key: SECRET } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const text = await r.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ key: 'openai', configured: true, fields: [{ key: 'api_key', masked: true, set: true, last4: 'cdef' }] });
    expect(Object.keys(JSON.parse(text).fields[0]).sort()).toEqual(['hint', 'key', 'label', 'last4', 'masked', 'required', 'set']); // ningún campo «value»

    const l = JSON.stringify(await list());
    expect(l).not.toContain(SECRET);
    expect(l).toContain('"last4":"cdef"');

    const r1 = (await row('text_ai', 'openai'))!;
    expect(r1.secrets_sealed).toMatch(/^ss1:1:/);
    expect(r1.secrets_sealed).not.toContain(SECRET);
    expect(JSON.stringify(r1)).not.toContain(SECRET);
    expect(r1.key_version).toBe(1);
    expect(r1.secret_hints).toEqual({ api_key: 'cdef' });
    expect(r1.updated_by).toBe(IDS.root);
    expect(vault1.open(r1.secrets_sealed!, 'text_ai/openai')).toEqual({ api_key: SECRET }); // ida y vuelta con la clave del servidor
    expect(() => vault1.open(r1.secrets_sealed!, 'text_ai/gemini')).toThrow(); // atado a su fila
  });

  it('la auditoría de plataforma registra QUIÉN y QUÉ CAMPOS, nunca los valores', async () => {
    await save('storage', 's3_compatible', { values: S3 });
    const a = await audits('provider.credentials_saved');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_user_id: IDS.root, details: { service: 'storage', provider: 's3_compatible', fields_changed: ['endpoint', 'region', 'bucket', 'access_key_id', 'secret_access_key'], cleared: [] } });
    const all = JSON.stringify(await audits());
    for (const v of Object.values(S3)) expect(all).not.toContain(v);
  });

  it('también la URL, la región y el bucket: solo se ven sus últimos 4 (el valor nunca vuelve); se completa por partes y «configurado» exige todos los obligatorios', async () => {
    await save('storage', 's3_compatible', { values: { endpoint: S3.endpoint, region: S3.region, bucket: S3.bucket } });
    let p = prov(await list(), 'storage', 's3_compatible');
    expect(p.configured).toBe(false);
    expect(field(p, 'endpoint')).toMatchObject({ set: true, masked: false, last4: 'test' });
    expect(field(p, 'region')).toMatchObject({ set: true, last4: 'st-1' });
    expect(field(p, 'bucket')).toMatchObject({ set: true, last4: 'ivos' });
    expect(field(p, 'access_key_id')).toMatchObject({ set: false, masked: true, last4: null });
    const text = JSON.stringify(await list());
    for (const v of [S3.endpoint, 's3.ejemplo.test', S3.region, S3.bucket]) expect(text).not.toContain(v);

    await save('storage', 's3_compatible', { values: { access_key_id: S3.access_key_id } });
    expect(prov(await list(), 'storage', 's3_compatible').configured).toBe(false);
    await save('storage', 's3_compatible', { values: { secret_access_key: S3.secret_access_key } });
    p = prov(await list(), 'storage', 's3_compatible');
    expect(p.configured).toBe(true);
    expect(field(p, 'secret_access_key')).toMatchObject({ set: true, last4: 'EKEY' });
    expect(vault1.open((await row('storage', 's3_compatible'))!.secrets_sealed!, 'storage/s3_compatible')).toEqual(S3); // todos juntos en el sobre
  });

  it('reemplazar un valor cambia el sobre y el sufijo sin tocar los demás; un valor corto no revela nada', async () => {
    await save('storage', 's3_compatible', { values: S3 });
    const before = (await row('storage', 's3_compatible'))!;
    await save('storage', 's3_compatible', { values: { access_key_id: 'AKIA-OTRA-CLAVE-9999' } });
    const after = (await row('storage', 's3_compatible'))!;
    expect(after.secrets_sealed).not.toBe(before.secrets_sealed);
    expect(after.secret_hints).toEqual({ endpoint: 'test', region: 'st-1', bucket: 'ivos', access_key_id: '9999', secret_access_key: 'EKEY' });
    expect(vault1.open(after.secrets_sealed!, 'storage/s3_compatible')).toEqual({ ...S3, access_key_id: 'AKIA-OTRA-CLAVE-9999' });

    await save('voice_ai', 'vapi', { values: { api_key: 'abc123' } });
    expect(field(prov(await list(), 'voice_ai', 'vapi'), 'api_key')).toMatchObject({ set: true, last4: null });
    expect((await row('voice_ai', 'vapi'))!.secret_hints).toEqual({ api_key: null });
  });

  it('quitar campos: uno, varios o todos (el sobre desaparece)', async () => {
    await save('storage', 's3_compatible', { values: S3 });
    await save('storage', 's3_compatible', { clear: ['secret_access_key', 'region'] });
    let r = (await row('storage', 's3_compatible'))!;
    expect(r.secret_hints).toEqual({ endpoint: 'test', bucket: 'ivos', access_key_id: '0001' });
    expect(vault1.open(r.secrets_sealed!, 'storage/s3_compatible')).toEqual({ endpoint: S3.endpoint, bucket: S3.bucket, access_key_id: S3.access_key_id });
    await save('storage', 's3_compatible', { clear: ['endpoint', 'bucket', 'access_key_id'] });
    r = (await row('storage', 's3_compatible'))!;
    expect(r.secrets_sealed).toBeNull();
    expect(r.key_version).toBeNull();
    expect(r.secret_hints).toEqual({});
    expect((await audits('provider.credentials_saved')).at(-1)!.details).toMatchObject({ cleared: ['endpoint', 'bucket', 'access_key_id'], fields_changed: [] });
  });

  it('validación: campos desconocidos, URL, espacios, longitudes, caracteres de control, cuerpos vacíos o con la forma antigua → 400, sin eco del valor', async () => {
    const bad: Array<[string, unknown]> = [
      ['campo desconocido', { values: { nope: 'x1234567' } }],
      ['forma antigua: settings', { settings: { bucket: 'x1234567' } }],
      ['forma antigua: secrets', { secrets: { access_key_id: 'AKIA1234567890' } }],
      ['URL ftp', { values: { endpoint: 'ftp://s3.ejemplo.test' } }],
      ['URL con credenciales', { values: { endpoint: 'https://usuario:clave@s3.ejemplo.test' } }],
      ['URL con query', { values: { endpoint: 'https://s3.ejemplo.test/?x=1' } }],
      ['URL con fragmento', { values: { endpoint: 'https://s3.ejemplo.test/#x' } }],
      ['no es URL', { values: { endpoint: 'esto-no-es-una-url' } }],
      ['valor con espacio', { values: { access_key_id: 'AKIA 1234 5678' } }],
      ['valor con salto de línea', { values: { access_key_id: 'AKIA1234\n5678' } }],
      ['valor largo', { values: { access_key_id: 'A'.repeat(1001) } }],
      ['valor vacío', { values: { bucket: '   ' } }],
      ['valor con control', { values: { bucket: 'bu\u0007cket' } }],
      ['clear desconocido', { clear: ['nope'] }],
      ['guardar y quitar a la vez', { values: { bucket: 'ss-archivos' }, clear: ['bucket'] }],
      ['cuerpo vacío', {}],
      ['campo extra', { values: { bucket: 'ss-archivos' }, organization_id: ORG_A }],
      ['valor no texto', { values: { bucket: 5 } }],
    ];
    for (const [name, body] of bad) {
      const r = await save('storage', 's3_compatible', body);
      expect(r.status, name).toBe(400);
      const t = await r.text();
      expect(t, name).not.toContain('AKIA1234');
      expect(t, name).not.toContain('AKIA 1234');
      expect(t, name).not.toContain('usuario:clave');
    }
    expect(await row('storage', 's3_compatible')).toBeUndefined();
    expect(await audits()).toEqual([]);
  });

  it('servicio o proveedor inexistentes 404; claves mal formadas 400; servicios que no se configuran aquí 409 (auth, correo, antibots, base vectorial, GHL)', async () => {
    expect((await save('nada', 'openai', { values: { api_key: SECRET } })).status).toBe(404);
    expect((await save('text_ai', 'nada', { values: { api_key: SECRET } })).status).toBe(404);
    expect((await save('payments', 'stripe', { values: { api_key: SECRET } })).status).toBe(404); // decisión abierta: sin candidatos
    expect((await save('Text_AI', 'openai', { values: { api_key: SECRET } })).status).toBe(400);
    expect((await call('PUT', '/platform/providers/text_ai/active', rootToken, { provider: 'OpenAI' })).status).toBe(400);
    for (const [s, p] of [['auth', 'local'], ['mail', 'resend'], ['captcha', 'turnstile'], ['vector', 'pgvector'], ['ghl', 'private_token']] as const) {
      const r = await save(s, p, { values: { campo: SECRET } });
      expect(r.status, `${s} save`).toBe(409);
      expect(await code(r)).toBe('SERVICE_NOT_CONFIGURABLE');
      expect((await activate(s, p)).status, `${s} activate`).toBe(409);
      expect((await clear(s, p)).status, `${s} clear`).toBe(409);
    }
    expect(await audits()).toEqual([]);
  });
});

describe('proveedor en uso', () => {
  it('no se activa sin sus credenciales; con ellas sí; repetir no cambia nada; cambiar y desactivar quedan auditados', async () => {
    const r0 = await activate('text_ai', 'openai');
    expect(r0.status).toBe(409);
    expect(await code(r0)).toBe('PROVIDER_NOT_CONFIGURED');
    await save('text_ai', 'openai', { values: { api_key: SECRET } });
    await save('text_ai', 'gemini', { values: { api_key: SECRET2 } });

    expect(await json(await activate('text_ai', 'openai'))).toEqual({ service: 'text_ai', active: 'openai', changed: true });
    expect(svc(await list(), 'text_ai').active).toBe('openai');
    expect(await json(await activate('text_ai', 'openai'))).toEqual({ service: 'text_ai', active: 'openai', changed: false });
    expect(await json(await activate('text_ai', 'gemini'))).toMatchObject({ active: 'gemini', changed: true });
    expect(await json(await activate('text_ai', null))).toEqual({ service: 'text_ai', active: null, changed: true });
    expect(svc(await list(), 'text_ai').active).toBeNull();

    const a = (await audits()).filter((x) => x.action.startsWith('provider.act') || x.action.startsWith('provider.deact'));
    expect(a.map((x) => [x.action, x.details['provider'], x.details['previous']])).toEqual([['provider.activated', 'openai', null], ['provider.activated', 'gemini', 'openai'], ['provider.deactivated', null, 'gemini']]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM provider_selection`)).rows[0].n).toBe(1); // una fila por servicio, no por cambio
  });

  it('un proveedor de otro servicio o inexistente es 404; desactivar un servicio sin proveedor no cambia nada', async () => {
    expect((await activate('text_ai', 'evolution')).status).toBe(404);
    expect((await activate('whatsapp_qr', 'openai')).status).toBe(404);
    expect((await activate('nada', 'openai')).status).toBe(404);
    expect(await json(await activate('payments', null))).toEqual({ service: 'payments', active: null, changed: false });
  });

  it('el que está en uso no se puede quitar ni dejar incompleto; sí se puede cambiar un valor; sus vecinos sí se quitan', async () => {
    await save('storage', 's3_compatible', { values: S3 });
    await save('text_ai', 'openai', { values: { api_key: SECRET } });
    await save('text_ai', 'gemini', { values: { api_key: SECRET2 } });
    await activate('storage', 's3_compatible');
    await activate('text_ai', 'openai');

    const r = await clear('text_ai', 'openai');
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('PROVIDER_ACTIVE');
    for (const k of ['secret_access_key', 'region']) {
      const x = await save('storage', 's3_compatible', { clear: [k] });
      expect(x.status, k).toBe(409);
      expect(await code(x)).toBe('PROVIDER_ACTIVE');
    }
    expect(vault1.open((await row('storage', 's3_compatible'))!.secrets_sealed!, 'storage/s3_compatible')).toEqual(S3); // intacto

    expect((await save('storage', 's3_compatible', { values: { secret_access_key: 'wJalrXUtnFEMI-NUEVA-CLAVE-XYZ' } })).status).toBe(200);
    expect(await json(await clear('text_ai', 'gemini'))).toEqual({ service: 'text_ai', provider: 'gemini', cleared: true });
    expect(await json(await clear('text_ai', 'gemini'))).toEqual({ service: 'text_ai', provider: 'gemini', cleared: false });
    expect(await row('text_ai', 'gemini')).toBeUndefined();
    expect((await audits('provider.credentials_cleared')).map((x) => x.details)).toEqual([{ service: 'text_ai', provider: 'gemini' }]);
  });

  it('los candidatos de IA de voz guardan credenciales para el PoC, pero no hay proveedor en uso hasta decidirlo', async () => {
    await save('voice_ai', 'retell', { values: { api_key: SECRET } });
    await save('voice_ai', 'vapi', { values: { api_key: SECRET2 } });
    const l = await list();
    expect(svc(l, 'voice_ai').active).toBeNull();
    expect(svc(l, 'voice_ai').providers.map((p) => [p.key, p.configured])).toEqual([['retell', true], ['vapi', true]]);
  });
});

describe('concurrencia', () => {
  it('guardar campos distintos a la vez no pierde ninguno (candado por servicio)', async () => {
    const rs = await Promise.all(Object.entries(S3).map(([k, v]) => save('storage', 's3_compatible', { values: { [k]: v } })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const r = (await row('storage', 's3_compatible'))!;
    expect(vault1.open(r.secrets_sealed!, 'storage/s3_compatible')).toEqual(S3);
    expect(Object.keys(r.secret_hints).sort()).toEqual(Object.keys(S3).sort());
    expect(prov(await list(), 'storage', 's3_compatible').configured).toBe(true);
  });

  it('activar dos proveedores del mismo servicio a la vez deja exactamente uno en uso', async () => {
    await save('text_ai', 'openai', { values: { api_key: SECRET } });
    await save('text_ai', 'gemini', { values: { api_key: SECRET2 } });
    const rs = await Promise.all([activate('text_ai', 'openai'), activate('text_ai', 'gemini'), activate('text_ai', 'openrouter')]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 409]); // openrouter no tiene credenciales
    const active = svc(await list(), 'text_ai').active;
    expect(['openai', 'gemini']).toContain(active);
    expect((await admin.query(`SELECT count(*)::int AS n FROM provider_selection WHERE service = 'text_ai'`)).rows[0].n).toBe(1);
  });
});

describe('sin clave de cifrado o con otra clave', () => {
  it('sin PROVIDER_CREDENTIALS_KEY: la lista avisa; guardar o quitar valores responde 503 y no cambia nada; elegir proveedor sigue funcionando', async () => {
    const { base: b } = await start({});
    const t = await login('root@plat.test', b);
    expect((await list(b, t)).vault).toEqual({ available: false });
    const r = await save('whatsapp_qr', 'evolution', { values: { base_url: 'https://evo.ejemplo.test', api_key: SECRET } }, b, t);
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('PROVIDER_VAULT_UNAVAILABLE');
    expect((await save('whatsapp_qr', 'evolution', { clear: ['api_key'] }, b, t)).status).toBe(503);
    expect(await row('whatsapp_qr', 'evolution')).toBeUndefined();
    expect(await audits()).toEqual([]);
    expect((await activate('text_ai', null, b, t)).status).toBe(200);
  });

  it('con OTRA clave que la usada al sellar: 503 claro, la fila queda intacta y el valor no se pierde', async () => {
    await save('text_ai', 'openai', { values: { api_key: SECRET } });
    const sealed = (await row('text_ai', 'openai'))!.secrets_sealed;
    const { base: b } = await start({ PROVIDER_CREDENTIALS_KEY: KEY2 });
    const t = await login('root@plat.test', b);
    const r = await save('text_ai', 'openai', { values: { api_key: SECRET2 } }, b, t);
    expect(r.status).toBe(503);
    expect(await code(r)).toBe('PROVIDER_VAULT_MISMATCH');
    expect((await row('text_ai', 'openai'))!.secrets_sealed).toBe(sealed);
  });

  it('rotación: con la clave vigente nueva y la anterior, lo guardado sigue abriéndose y al guardar se vuelve a sellar con la nueva', async () => {
    await save('storage', 's3_compatible', { values: S3 });
    expect((await row('storage', 's3_compatible'))!.key_version).toBe(1);
    const { base: b } = await start({ PROVIDER_CREDENTIALS_KEY: KEY2, PROVIDER_CREDENTIALS_KEY_VERSION: '2', PROVIDER_CREDENTIALS_KEY_PREVIOUS: KEY1, PROVIDER_CREDENTIALS_KEY_PREVIOUS_VERSION: '1' });
    const t = await login('root@plat.test', b);
    expect((await save('storage', 's3_compatible', { values: { secret_access_key: 'wJalrXUtnFEMI-ROTADA-0000-ABCD' } }, b, t)).status).toBe(200);
    const r = (await row('storage', 's3_compatible'))!;
    expect(r.key_version).toBe(2);
    const v2 = CredentialVault.fromConfig({ current: { version: 2, key: KEY2 }, previous: undefined })!;
    expect(v2.open(r.secrets_sealed!, 'storage/s3_compatible')).toEqual({ ...S3, secret_access_key: 'wJalrXUtnFEMI-ROTADA-0000-ABCD' });
    expect(() => vault1.open(r.secrets_sealed!, 'storage/s3_compatible')).toThrow();
  });
});

describe('roles de base de datos sobre las tablas de proveedores', () => {
  it('app_rw y app_identity NO ven ni tocan nada; app_platform lee y escribe lo previsto, sin borrar selecciones ni tocar otras tablas', async () => {
    await save('text_ai', 'openai', { values: { api_key: SECRET } });
    await activate('text_ai', 'openai');
    const as = async (url: string, q: string, params: unknown[] = []) => {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        return await c.query(q, params);
      } finally {
        await c.end();
      }
    };
    for (const url of [info.rwUrl, info.identityUrl]) {
      for (const t of ['provider_credentials', 'provider_selection']) {
        for (const q of [`SELECT 1 FROM ${t}`, `UPDATE ${t} SET service = service`, `DELETE FROM ${t}`]) await expect(as(url, q), q).rejects.toThrow(/permission denied/);
      }
    }
    expect((await as(info.platformUrl, 'SELECT count(*)::int AS n FROM provider_credentials')).rows[0].n).toBe(1);
    expect((await as(info.platformUrl, 'SELECT count(*)::int AS n FROM provider_selection')).rows[0].n).toBe(1);
    await expect(as(info.platformUrl, 'DELETE FROM provider_selection')).rejects.toThrow(/permission denied/);
    await expect(as(info.platformUrl, 'TRUNCATE provider_credentials')).rejects.toThrow(/permission denied/);
    await expect(as(info.platformUrl, 'SELECT 1 FROM users')).rejects.toThrow(/permission denied/);
  });

  it('las restricciones de la BD protegen lo que la API ya valida (forma de las claves, sobre y versión consistentes)', async () => {
    const ins = (cols: string, vals: string) => admin.query(`INSERT INTO provider_credentials(service, provider, updated_by${cols}) VALUES ('text_ai', 'openai', gen_random_uuid()${vals})`);
    await expect(admin.query(`INSERT INTO provider_credentials(service, provider, updated_by) VALUES ('Text-AI', 'openai', gen_random_uuid())`)).rejects.toThrow(/provider_credentials_service_shape/);
    await expect(admin.query(`INSERT INTO provider_credentials(service, provider, updated_by) VALUES ('text_ai', 'open ai', gen_random_uuid())`)).rejects.toThrow(/provider_credentials_provider_shape/);
    await expect(ins(', secrets_sealed', `, 'ss1:1:x'`)).rejects.toThrow(/provider_credentials_sealed_consistent/);
    await expect(ins(', key_version', ', 1')).rejects.toThrow(/provider_credentials_sealed_consistent/);
    await expect(ins(', secrets_sealed, key_version', `, 'ss1:0:x', 0`)).rejects.toThrow(/provider_credentials_key_version/);
    await expect(ins(', secret_hints', `, '[]'::jsonb`)).rejects.toThrow(/provider_credentials_hints_object/);
    await expect(admin.query(`INSERT INTO provider_selection(service, provider, updated_by) VALUES ('text_ai', 'Open AI', gen_random_uuid())`)).rejects.toThrow(/provider_selection_provider_shape/);
  });
});
