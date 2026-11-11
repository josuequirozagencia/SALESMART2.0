// v11 S3 — Favicon de la plataforma (solo Súper Admin). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   GET /v1/platform/branding · PUT /v1/platform/branding/favicon · DELETE /v1/platform/branding/favicon
//   GET /v1/branding/favicon
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { StorageGateway } from '../../src/modules/attachments';
import { BrandingModule } from '../../src/modules/branding';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, TEST_AUTH_KEY } from '../support/constants';
import { ico, png, SVG } from '../support/favicon-images';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, BrandingModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // advisor de A
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agency
  root: 'f0000000-0000-4000-8000-0000000000f1',
};

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'dave' | 'root', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE sessions, auth_throttle, access_sessions, organization_members, organizations, users, platform_audit, platform_branding CASCADE');
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

const call = (method: string, path: string, token?: string, body?: Buffer, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/octet-stream' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body ? { body: new Uint8Array(body) } : {}) });
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, Buffer.from(JSON.stringify({ email, password: PW, token_transport: 'body' })), { 'content-type': 'application/json' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
interface View { has_favicon: boolean; version: string | null; content_type: string | null; bytes: number | null; px: number | null }
const put = (token: string | undefined, body: Buffer) => call('PUT', '/platform/branding/favicon', token, body);
const objects = (): string[] => [...app.get(StorageGateway, { strict: false }).fake.objects.keys()];
const audits = async () => (await admin.query(`SELECT action, details, actor_user_id FROM platform_audit WHERE action LIKE 'branding.%' ORDER BY at, id`)).rows as Array<{ action: string; details: Record<string, unknown>; actor_user_id: string }>;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'AI_PROVIDER', 'PROVIDER_CREDENTIALS_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, STORAGE_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  const fake = app.get(StorageGateway, { strict: false }).fake;
  fake.objects.clear();
  fake.down = false;
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
});

describe('acceso: solo el Súper Admin cambia la marca', () => {
  it('sin sesión es 401; asesora, administrador de empresa y agencia reciben 403 y no se guarda nada', async () => {
    expect((await call('GET', '/platform/branding')).status).toBe(401);
    expect((await put(undefined, png(64, 64))).status).toBe(401);
    for (const who of ['alice', 'carol', 'dave'] as const) {
      expect((await call('GET', '/platform/branding', T[who])).status, `${who} GET`).toBe(403);
      expect((await put(T[who], png(64, 64))).status, `${who} PUT`).toBe(403);
      expect((await call('DELETE', '/platform/branding/favicon', T[who])).status, `${who} DELETE`).toBe(403);
    }
    expect(objects()).toEqual([]);
    expect((await admin.query('SELECT count(*)::int AS n FROM platform_branding')).rows[0].n).toBe(0);
  });

  it('la aplicación de cliente (app_rw) no puede leer ni escribir platform_branding', async () => {
    const rw = new Client({ connectionString: info.rwUrl });
    await rw.connect();
    try {
      await expect(rw.query('SELECT * FROM platform_branding')).rejects.toThrow(/permission denied|permiso denegado/i);
      await expect(rw.query("INSERT INTO platform_branding(id) VALUES (1)")).rejects.toThrow(/permission denied|permiso denegado/i);
    } finally {
      await rw.end();
    }
  });
});

describe('favicon de la plataforma', () => {
  it('sin favicon cargado, la ruta pública entrega el icono por omisión (nunca un 404) y el Súper Admin ve «sin favicon»', async () => {
    const r = await call('GET', '/branding/favicon');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/svg+xml');
    expect(await r.text()).toContain('<svg');
    expect(await json<View>(await call('GET', '/platform/branding', T.root))).toMatchObject({ has_favicon: false, version: null });
  });

  it('subir un PNG válido lo guarda bajo platform/branding/, lo entrega sin sesión con ETag y caché, y responde 304 a la misma versión', async () => {
    const img = png(64, 64, 300);
    const up = await put(T.root, img);
    expect(up.status, await up.clone().text()).toBe(200);
    const v = await json<View>(up);
    expect(v).toMatchObject({ has_favicon: true, content_type: 'image/png', bytes: 300, px: 64 });
    expect(objects()).toHaveLength(1);
    expect(objects()[0]).toMatch(/^platform\/branding\/favicon-[0-9a-f-]{36}$/);
    expect(objects()[0]).toContain(v.version!);

    const pub = await call('GET', '/branding/favicon'); // sin sesión
    expect(pub.status).toBe(200);
    expect(pub.headers.get('content-type')).toBe('image/png');
    expect(pub.headers.get('cache-control')).toBe('public, max-age=300');
    expect(pub.headers.get('x-content-type-options')).toBe('nosniff');
    expect(pub.headers.get('etag')).toBe(`"${v.version}"`);
    expect(Buffer.from(await pub.arrayBuffer()).equals(img)).toBe(true);

    const again = await call('GET', '/branding/favicon', undefined, undefined, { 'if-none-match': `"${v.version}"` });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
  });

  it('la ruta pública solo entrega la imagen: ni cabeceras ni cuerpo mencionan empresas, usuarios o claves', async () => {
    await put(T.root, png(64, 64));
    const r = await call('GET', '/branding/favicon');
    const dump = JSON.stringify([...r.headers.entries()]) + Buffer.from(await r.arrayBuffer()).toString('latin1');
    for (const s of [ORG_A, IDS.root, IDS.alice, 'Barbería', 'organization', 'authorization', 'set-cookie']) expect(dump.toLowerCase()).not.toContain(s.toLowerCase());
  });

  it('reemplazarlo borra el archivo anterior, cambia la versión y la ruta pública entrega el nuevo al instante', async () => {
    const first = await json<View>(await put(T.root, png(64, 64)));
    const firstKey = objects()[0]!;
    const v2 = await json<View>(await put(T.root, ico([32, 32])));
    expect(v2.version).not.toBe(first.version);
    expect(v2).toMatchObject({ content_type: 'image/x-icon', px: 32 });
    expect(objects()).toHaveLength(1);
    expect(objects()).not.toContain(firstKey);
    const pub = await call('GET', '/branding/favicon');
    expect(pub.headers.get('content-type')).toBe('image/x-icon');
    expect(Buffer.from(await pub.arrayBuffer()).equals(ico([32, 32]))).toBe(true);
  });

  it('rechaza SVG (aunque diga ser PNG), no cuadrados, tamaños fuera de 32–512 px, archivos de más de 256 KB y archivos dañados, sin guardar nada', async () => {
    const cases: Array<[Buffer, number, string]> = [
      [SVG, 400, 'FAVICON_UNSUPPORTED'],
      [png(64, 32), 400, 'FAVICON_NOT_SQUARE'],
      [png(16, 16), 400, 'FAVICON_BAD_SIZE'],
      [png(1024, 1024), 400, 'FAVICON_BAD_SIZE'],
      [png(64, 64, 256 * 1024 + 1), 413, 'FAVICON_TOO_LARGE'],
      [png(64, 64).subarray(0, 20), 400, 'FAVICON_CORRUPT'],
      [Buffer.alloc(0), 400, 'FAVICON_EMPTY'],
    ];
    for (const [body, status, code] of cases) {
      const r = await call('PUT', '/platform/branding/favicon', T.root, body.length > 0 ? body : undefined, { 'content-type': 'image/png', 'content-length': String(body.length) });
      expect(r.status, code).toBe(status);
      expect((await json<{ error: { code: string } }>(r)).error.code).toBe(code);
    }
    expect(objects()).toEqual([]);
    expect((await json<View>(await call('GET', '/platform/branding', T.root))).has_favicon).toBe(false);
  });

  it('quitarlo borra el archivo y la plataforma vuelve al icono por omisión; quitar otra vez no es un error', async () => {
    await put(T.root, png(64, 64));
    const del = await call('DELETE', '/platform/branding/favicon', T.root);
    expect(del.status).toBe(200);
    expect(await json<View>(del)).toMatchObject({ has_favicon: false, version: null, content_type: null });
    expect(objects()).toEqual([]);
    expect((await call('GET', '/branding/favicon')).headers.get('content-type')).toBe('image/svg+xml');
    expect((await call('DELETE', '/platform/branding/favicon', T.root)).status).toBe(200);
    expect((await admin.query('SELECT count(*)::int AS n FROM platform_branding')).rows[0].n).toBe(1); // la fila no se borra
  });

  it('si el almacenamiento no responde: la subida da 503 y no cambia nada; ya subido, la ruta pública sigue entregando el icono por omisión (no un error)', async () => {
    const fake = app.get(StorageGateway, { strict: false }).fake;
    fake.down = true;
    const r = await put(T.root, png(64, 64));
    expect(r.status).toBe(503);
    expect((await admin.query('SELECT count(*)::int AS n FROM platform_branding')).rows[0].n).toBe(0);
    fake.down = false;
    await put(T.root, png(64, 64));
    fake.down = true;
    const pub = await call('GET', '/branding/favicon');
    expect(pub.status).toBe(200);
    expect(pub.headers.get('content-type')).toBe('image/svg+xml');
  });

  it('deja auditoría de plataforma (subir y quitar) con el Súper Admin como actor y sin el contenido de la imagen', async () => {
    const v = await json<View>(await put(T.root, png(64, 64)));
    await call('DELETE', '/platform/branding/favicon', T.root);
    const a = await audits();
    expect(a.map((x) => x.action)).toEqual(['branding.favicon.set', 'branding.favicon.cleared']);
    expect(a.every((x) => x.actor_user_id === IDS.root)).toBe(true);
    expect(a[0]!.details).toMatchObject({ content_type: 'image/png', px: 64, version: v.version });
    expect(JSON.stringify(a)).not.toMatch(/PNG|IHDR/);
  });
});
