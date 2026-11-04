// «Probar conexión» del almacenamiento (ADR-42). Ruta cubierta (el registro de endpoints exige que este archivo la mencione):
//   POST /v1/platform/providers/storage/test
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AttachmentsModule, FakeStorage, probeStorage, StorageError, StorageGateway, storageHint } from '../../src/modules/attachments';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, AttachmentsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = { platformOrg: '00000000-0000-4000-8000-0000000000f0', clientOrg: 'f4b00000-0000-4000-8000-0000000000c1', root: 'f0000000-0000-4000-8000-0000000000f1', alice: 'a0000000-0000-4000-8000-00000000000a' };
const SECRET = 'clave-secreta-que-no-debe-salir-0123456789';

/** Un almacenamiento que falla de la forma que se le diga, y recuerda qué se le pidió. */
class Flaky extends FakeStorage {
  readonly calls: string[] = [];
  constructor(private readonly failOn: Partial<Record<'put' | 'get' | 'signedUrl' | 'delete', StorageError>>) {
    super();
  }
  override async put(key: string, body: Buffer, type: string): Promise<void> {
    this.calls.push('put');
    if (this.failOn.put) throw this.failOn.put;
    await super.put(key, body, type);
  }
  override async get(key: string): Promise<Buffer> {
    this.calls.push('get');
    if (this.failOn.get) throw this.failOn.get;
    return super.get(key);
  }
  override async signedUrl(...a: Parameters<FakeStorage['signedUrl']>): Promise<string> {
    this.calls.push('signedUrl');
    if (this.failOn.signedUrl) throw this.failOn.signedUrl;
    return super.signedUrl(...a);
  }
  override async delete(key: string): Promise<void> {
    this.calls.push('delete');
    if (this.failOn.delete) throw this.failOn.delete;
    await super.delete(key);
  }
}

describe('probeStorage (la prueba en sí)', () => {
  it('con un almacenamiento sano: sube, lee, firma y borra; no deja nada', async () => {
    const s = new FakeStorage();
    const r = await probeStorage(s);
    expect(r).toMatchObject({ ok: true, provider: 'fake', hint: null });
    expect(r.steps.map((x) => [x.key, x.ok])).toEqual([['upload', true], ['download', true], ['url', true], ['delete', true]]);
    expect(r.steps.every((x) => x.message === null && x.detail === null)).toBe(true);
    expect(s.objects.size).toBe(0); // el archivo de prueba se borró
    expect([...s.objects.keys()].some((k) => k.startsWith('org/'))).toBe(false); // y nunca toca el espacio de una empresa
  });

  it('si falla la subida no intenta lo demás y no hay nada que limpiar', async () => {
    const s = new Flaky({ put: new StorageError('not_configured', 'El almacenamiento rechazó las credenciales: revisa Proveedores › Almacenamiento', 'Unauthorized http=401 code=- nada') });
    const r = await probeStorage(s);
    expect(r.ok).toBe(false);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ key: 'upload', ok: false, message: expect.stringContaining('credenciales'), detail: expect.stringContaining('http=401') });
    expect(r.hint).toMatch(/Access Key ID/);
    expect(s.calls).toEqual(['put']);
  });

  it('si falla un paso intermedio igual intenta borrar el archivo de prueba', async () => {
    const s = new Flaky({ get: new StorageError('unavailable', 'El almacenamiento no respondió', 'Error http=500 code=InternalError') });
    const r = await probeStorage(s);
    expect(r.ok).toBe(false);
    expect(r.steps.map((x) => [x.key, x.ok])).toEqual([['upload', true], ['download', false], ['url', true], ['delete', true]]);
    expect(s.calls).toContain('delete');
    expect(s.objects.size).toBe(0);
    expect(r.hint).toMatch(/del lado|de su lado|fallando/);
  });

  it('un fallo al borrar se informa (la prueba no pasa) pero no oculta lo demás', async () => {
    const s = new Flaky({ delete: new StorageError('not_configured', 'El almacenamiento rechazó las credenciales: revisa Proveedores › Almacenamiento', 'AccessDenied http=403') });
    const r = await probeStorage(s);
    expect(r.ok).toBe(false);
    expect(r.steps.map((x) => x.ok)).toEqual([true, true, true, false]);
  });

  it('un error que no es de almacenamiento no revienta: se informa como «no respondió»', async () => {
    const s = new Flaky({});
    s.put = () => Promise.reject(new Error('boom'));
    const r = await probeStorage(s);
    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ ok: false, message: 'El almacenamiento no respondió', detail: null });
  });

  it('la respuesta no lleva claves aunque el almacenamiento las tuviera a mano', async () => {
    const s = new Flaky({ put: new StorageError('unavailable', 'El almacenamiento no respondió', 'Error http=- code=- write EPROTO alert 40') });
    const r = await probeStorage(s);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});

describe('storageHint: qué revisar según el error', () => {
  const cases: Array<[Parameters<typeof storageHint>, RegExp | null]> = [
    [['unavailable', 'El almacenamiento no respondió', 'Error http=- code=[REDACTED] write EPROTO ...SSL alert number 40'], /conexión segura.*Endpoint.*ID de cuenta/],
    [['unavailable', 'El almacenamiento no respondió', 'Error http=- code=ENOTFOUND getaddrinfo ENOTFOUND x.r2.cloudflarestorage.com'], /conexión segura/],
    [['unavailable', 'El almacenamiento no respondió', 'Error http=- code=ETIMEDOUT connect ETIMEDOUT'], /no respondió a tiempo/],
    [['not_configured', 'El almacenamiento rechazó las credenciales: revisa Proveedores › Almacenamiento', 'Unauthorized http=401'], /Access Key ID.*Secret Access Key/],
    [['not_configured', 'El bucket no existe o la llave no tiene acceso a él: revisa el nombre', 'NoSuchBucket http=404'], /nombre del bucket/],
    [['not_configured', 'El almacenamiento de archivos aún no está configurado: el Súper Admin debe guardarlo', null], /Falta configurar/],
    [['not_found', 'El archivo no existe', 'NotFound http=404'], /Endpoint y el nombre del bucket/],
    [['unavailable', 'El almacenamiento no respondió', 'InternalError http=503 code=ServiceUnavailable'], /fallando/],
    [['unavailable', 'El almacenamiento no respondió', null], null],
  ];
  it.each(cases)('%j', (args, expected) => {
    const h = storageHint(...args);
    if (expected === null) expect(h).toBeNull();
    else expect(h).toMatch(expected);
  });
});

// ── La ruta ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

let admin: Client;
let app: INestApplication;
let base = '';
let storage: StorageGateway;
const saved = { ...process.env };

const call = (method: string, path: string, token?: string) => fetch(`${base}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
async function login(email: string): Promise<string> {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW, token_transport: 'body' }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

describe('POST /v1/platform/providers/storage/test', () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    const hash = await new Argon2idHasher().hash(PW);
    for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER']) delete process.env[k];
    Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AUDIO_TRANSCODER: 'fake' });
    delete process.env['DATABASE_URL_OWNER'];
    await admin.query('TRUNCATE sessions, auth_throttle, organization_members, organizations, users, plans CASCADE');
    for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [IDS.clientOrg, 'client', 'Empresa de prueba']]) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
    for (const [id, email] of [[IDS.root, 'root@plat.test'], [IDS.alice, 'alice@c.test']]) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, hash]);
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,'super_admin'), (gen_random_uuid(),$3,$4,'client_admin')`, [IDS.root, IDS.platformOrg, IDS.alice, IDS.clientOrg]);
    app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/v1`;
    storage = app.get(StorageGateway);
  });
  afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });

  it('sin sesión 401; un administrador de empresa 403; no hace nada', async () => {
    storage.fake.objects.clear();
    expect((await call('POST', '/platform/providers/storage/test')).status).toBe(401);
    expect((await call('POST', '/platform/providers/storage/test', await login('alice@c.test'))).status).toBe(403);
    expect(storage.fake.objects.size).toBe(0);
  });

  it('el Súper Admin la ejecuta: ok, sin guardar en caché y sin dejar el archivo de prueba', async () => {
    storage.fake.down = false;
    const r = await call('POST', '/platform/providers/storage/test', await login('root@plat.test'));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    const b = (await r.json()) as { ok: boolean; provider: string; steps: Array<{ key: string; ok: boolean }>; hint: string | null };
    expect(b).toMatchObject({ ok: true, provider: 'fake', hint: null });
    expect(b.steps.map((s) => s.key)).toEqual(['upload', 'download', 'url', 'delete']);
    expect(storage.fake.objects.size).toBe(0);
  });

  it('si el almacenamiento no responde dice en qué paso falló, con el mensaje y el detalle', async () => {
    storage.fake.down = true;
    try {
      const r = await call('POST', '/platform/providers/storage/test', await login('root@plat.test'));
      expect(r.status).toBe(200); // la prueba se ejecutó: el resultado dice que falló
      const b = (await r.json()) as { ok: boolean; steps: Array<{ key: string; ok: boolean; message: string | null }> };
      expect(b.ok).toBe(false);
      expect(b.steps).toHaveLength(1);
      expect(b.steps[0]).toMatchObject({ key: 'upload', ok: false, message: 'El almacenamiento no responde' });
    } finally {
      storage.fake.down = false;
    }
  });
});
