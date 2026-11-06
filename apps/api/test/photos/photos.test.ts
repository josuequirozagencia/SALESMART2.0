// v5 — Fotos de perfil: la foto de cada persona (la sube ella) y la de los contactos de WhatsApp por QR (la baja una tarea). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/photos
//   GET /v1/me/photo
//   PUT /v1/me/photo
//   DELETE /v1/me/photo
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { StorageGateway } from '../../src/modules/attachments';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { MAX_PHOTO_BYTES, PhotosModule } from '../../src/modules/photos';
import { PlatformCredentialsReader } from '../../src/modules/platform';
import { ContactPhotosJob, FAKE_QR_KEY, FakeQrSession, PHOTO_DOWNLOADER, QR_SESSION, QrModule, type PhotoDownloader } from '../../src/modules/qr';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, PhotosModule, QrModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  dani: 'd0000000-0000-4000-8000-0000000000d4', // asesor de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 9)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(60, 1)]);

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'dani' | 'bob', string>;
let storage: StorageGateway;
let qr: FakeQrSession;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE conversations, contact_phones, contacts, qr_accounts, channel_accounts, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
  await admin.query('TRUNCATE qr_routes');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.dani, 'dani@a.test', 'Daniel Ríos'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.dani, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

type Row = Record<string, unknown>;
const call = (method: string, path: string, token?: string) => fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) } });
async function login(email: string): Promise<string> {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW, token_transport: 'body' }) });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const put = (token: string | undefined, bytes: Buffer) => fetch(`${base}/me/photo`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: new Uint8Array(bytes) });
const memberKey = async (user: string, org: string): Promise<string | null> => ((await admin.query(`SELECT photo_key FROM organization_members WHERE user_id = $1 AND organization_id = $2`, [user, org])).rows[0] as Row).photo_key as string | null;
const contactRow = async (id: string): Promise<Row> => (await admin.query(`SELECT photo_key, photo_checked_at FROM contacts WHERE id = $1`, [id])).rows[0] as Row;
const insertContact = async (org: string, name: string, phone: string, owner: string | null = null, photoKey: string | null = null): Promise<string> => {
  const id = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id, photo_key) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`, [org, name, owner, photoKey])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, id, phone]);
  return id;
};
/** Una conexión QR con la sesión en `state` y una conversación del contacto en ella. */
async function qrChannel(org: string, instance: string, state: string, contact: string): Promise<void> {
  const ch = (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, is_official, name) VALUES (gen_random_uuid(), $1, 'evolution', false, 'QR') RETURNING id`, [org])).rows[0].id as string;
  await admin.query(`INSERT INTO qr_accounts(organization_id, channel_account_id, instance_name, state) VALUES ($1, $2, $3, $4)`, [org, ch, instance, state]);
  await admin.query(`INSERT INTO qr_routes(id, organization_id, channel_account_id, token_hash) VALUES (gen_random_uuid(), $1, $2, $3)`, [org, ch, randomBytes(32).toString('hex')]);
  await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id) VALUES (gen_random_uuid(), $1, $2, $3)`, [org, contact, ch]);
  qr.instances.set(instance, { state: state === 'open' ? 'open' : 'closed', webhookUrl: 'x', qrCalls: 0 });
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'QR_PROVIDER', 'WHATSAPP_PROVIDER', 'PROVIDER_CREDENTIALS_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', QR_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: randomBytes(32).toString('base64') });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
  storage = app.get(StorageGateway);
  qr = app.get<FakeQrSession>(QR_SESSION);
});
afterAll(async () => {
  await app.close();
  await admin.end();
  process.env = saved;
});
beforeEach(async () => {
  await seed();
  app.get(OrgDirectoryService).invalidate();
  storage.fake.objects.clear();
  storage.fake.down = false;
  qr.reset();
  vi.spyOn(app.get(PlatformCredentialsReader), 'active').mockImplementation((service: string) => Promise.resolve(service === 'whatsapp_qr' ? { provider: 'evolution', values: { base_url: 'https://evolution.ejemplo.com', api_key: FAKE_QR_KEY } } : null));
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), dani: await login('dani@a.test'), bob: await login('bob@b.test') };
});
afterEach(() => vi.restoreAllMocks());

describe('mi foto', () => {
  it('sin sesión 401; subir una imagen la guarda bajo org/<empresa>/members/<persona>/, devuelve una URL firmada y NUNCA la clave', async () => {
    expect((await put(undefined, PNG)).status).toBe(401);
    expect((await call('GET', '/me/photo')).status).toBe(401);
    expect((await call('DELETE', '/me/photo')).status).toBe(401);
    const r = await put(T.carol, PNG);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as Row;
    expect(body['photo_url']).toEqual(expect.stringMatching(/^https:\/\/fake-storage\.test\//));
    const key = await memberKey(IDS.carol, ORG_A);
    expect(key).toMatch(new RegExp(`^org/${ORG_A}/members/${IDS.carol}/[0-9a-f-]+\\.png$`));
    expect(Object.keys(body)).toEqual(['photo_url']); // solo la URL firmada: ningún campo con la clave
    expect(storage.fake.objects.get(key!)?.contentType).toBe('image/png');
    const mine = (await (await call('GET', '/me/photo', T.carol)).json()) as Row;
    expect(mine['photo_url']).toEqual(expect.stringContaining('fake-storage.test'));
    // quien no la tiene
    expect(((await (await call('GET', '/me/photo', T.dani)).json()) as Row)['photo_url']).toBeNull();
  });

  it('cambiarla borra la anterior; quitarla deja la persona sin foto y borra el archivo', async () => {
    await put(T.carol, PNG);
    const first = (await memberKey(IDS.carol, ORG_A))!;
    expect((await put(T.carol, JPEG)).status).toBe(200);
    const second = (await memberKey(IDS.carol, ORG_A))!;
    expect(second).toMatch(/\.jpg$/);
    expect(storage.fake.objects.has(first)).toBe(false);
    expect(storage.fake.objects.has(second)).toBe(true);
    const r = await call('DELETE', '/me/photo', T.carol);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Row)['photo_url']).toBeNull();
    expect(await memberKey(IDS.carol, ORG_A)).toBeNull();
    expect(storage.fake.objects.has(second)).toBe(false);
  });

  it('valida el contenido: vacío 400, GIF 415 (por contenido, no por nombre), demasiado grande 413, y un almacenamiento caído 503 sin tocar lo guardado', async () => {
    expect((await put(T.carol, Buffer.alloc(0))).status).toBe(400);
    expect((await put(T.carol, GIF)).status).toBe(415);
    expect((await put(T.carol, Buffer.concat([PNG, Buffer.alloc(MAX_PHOTO_BYTES, 1)]))).status).toBe(413);
    expect(await memberKey(IDS.carol, ORG_A)).toBeNull();
    await put(T.carol, PNG);
    const before = await memberKey(IDS.carol, ORG_A);
    storage.fake.down = true;
    expect((await put(T.carol, JPEG)).status).toBe(503);
    expect(await memberKey(IDS.carol, ORG_A)).toBe(before);
  });

  it('A↔B: la foto es por empresa; cambiarla en A no toca la membresía de otra empresa', async () => {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,'advisor')`, [IDS.carol, ORG_B]);
    await put(T.carol, PNG);
    expect(await memberKey(IDS.carol, ORG_A)).not.toBeNull();
    expect(await memberKey(IDS.carol, ORG_B)).toBeNull();
  });
});

describe('GET /photos: las URL de lo que la pantalla muestra', () => {
  it('da la foto de las personas de la empresa y de los contactos; lo que no tiene foto no aparece', async () => {
    await put(T.carol, PNG);
    const withPhoto = await insertContact(ORG_A, 'Ana', '+593990000001', IDS.carol, `org/${ORG_A}/contacts/x/a.jpg`);
    const without = await insertContact(ORG_A, 'Beto', '+593990000002', IDS.carol);
    const r = await call('GET', `/photos?contacts=${withPhoto},${without}&users=${IDS.carol},${IDS.dani}`, T.alice);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as { contacts: Record<string, string>; users: Record<string, string> };
    expect(Object.keys(body.users)).toEqual([IDS.carol]);
    expect(Object.keys(body.contacts)).toEqual([withPhoto]);
    expect(body.contacts[withPhoto]).toEqual(expect.stringMatching(/^https:\/\/fake-storage\.test\/org\//));
    expect(JSON.stringify(body)).not.toContain('photo_key');
  });

  it('visibilidad: un asesor solo recibe la foto de SUS contactos; el administrador, la de todos', async () => {
    const mine = await insertContact(ORG_A, 'Mía', '+593990000003', IDS.carol, `org/${ORG_A}/contacts/m/a.jpg`);
    const theirs = await insertContact(ORG_A, 'Ajena', '+593990000004', IDS.dani, `org/${ORG_A}/contacts/t/a.jpg`);
    const asCarol = (await (await call('GET', `/photos?contacts=${mine},${theirs}`, T.carol)).json()) as { contacts: Record<string, string> };
    expect(Object.keys(asCarol.contacts)).toEqual([mine]);
    const asAlice = (await (await call('GET', `/photos?contacts=${mine},${theirs}`, T.alice)).json()) as { contacts: Record<string, string> };
    expect(Object.keys(asAlice.contacts).sort()).toEqual([mine, theirs].sort());
  });

  it('A↔B: ni los contactos ni las personas de otra empresa se resuelven, y un contacto borrado tampoco', async () => {
    await put(T.carol, PNG);
    const inA = await insertContact(ORG_A, 'De A', '+593990000005', IDS.carol, `org/${ORG_A}/contacts/a/a.jpg`);
    const inB = await insertContact(ORG_B, 'De B', '+593990000006', IDS.bob, `org/${ORG_B}/contacts/b/a.jpg`);
    const asBob = (await (await call('GET', `/photos?contacts=${inA},${inB}&users=${IDS.carol},${IDS.bob}`, T.bob)).json()) as { contacts: Record<string, string>; users: Record<string, string> };
    expect(Object.keys(asBob.contacts)).toEqual([inB]);
    expect(asBob.users).toEqual({}); // Bob no tiene foto y Carolina no es de su empresa
    await admin.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [inA]);
    const asAlice = (await (await call('GET', `/photos?contacts=${inA}`, T.alice)).json()) as { contacts: Record<string, string> };
    expect(asAlice.contacts).toEqual({});
  });

  it('valida la consulta: ids que no son UUID o más de 50 → 400; sin ids → vacío; sin sesión 401', async () => {
    expect((await call('GET', '/photos?contacts=no-es-uuid', T.alice)).status).toBe(400);
    const many = Array.from({ length: 51 }, () => '11111111-1111-4111-8111-111111111111').join(',');
    expect((await call('GET', `/photos?users=${many}`, T.alice)).status).toBe(400);
    expect(await (await call('GET', '/photos', T.alice)).json()).toEqual({ contacts: {}, users: {} });
    expect((await call('GET', '/photos')).status).toBe(401);
  });

  it('un almacenamiento caído no rompe la respuesta: se responde sin fotos', async () => {
    const c = await insertContact(ORG_A, 'Ana', '+593990000007', IDS.carol, `org/${ORG_A}/contacts/x/a.jpg`);
    storage.fake.down = true;
    const r = await call('GET', `/photos?contacts=${c}`, T.alice);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ contacts: {}, users: {} });
  });
});

describe('tarea contact-photos: la foto de los contactos que escriben por QR', () => {
  const downloader = (): { download: (url: string) => Promise<Buffer | null> } => app.get<PhotoDownloader>(PHOTO_DOWNLOADER) as unknown as { download: (url: string) => Promise<Buffer | null> };
  const run = () => app.get(ContactPhotosJob).run(new Date());

  it('pide la foto con la sesión abierta, la guarda bajo org/<empresa>/contacts/<contacto>/ y anota la consulta', async () => {
    const c = await insertContact(ORG_A, 'Ana', '+593990000010', IDS.carol);
    await qrChannel(ORG_A, 'ss-inst-a-0001', 'open', c);
    qr.pictures.set('593990000010', 'https://pps.whatsapp.net/v/ana.jpg');
    const seen: string[] = [];
    downloader().download = (url) => (seen.push(url), Promise.resolve(JPEG));
    expect(await run()).toBe(1);
    expect(seen).toEqual(['https://pps.whatsapp.net/v/ana.jpg']);
    const row = await contactRow(c);
    expect(row['photo_key']).toMatch(new RegExp(`^org/${ORG_A}/contacts/${c}/[0-9a-f-]+\\.jpg$`));
    expect(row['photo_checked_at']).not.toBeNull();
    expect(storage.fake.objects.get(row['photo_key'] as string)?.contentType).toBe('image/jpeg');
    // ya tiene foto: no se vuelve a pedir
    seen.length = 0;
    expect(await run()).toBe(0);
    expect(seen).toEqual([]);
  });

  it('sin foto o con la privacidad cerrada solo se anota la consulta, y no se repite antes de 7 días', async () => {
    const c = await insertContact(ORG_A, 'Sin foto', '+593990000011', IDS.carol);
    await qrChannel(ORG_A, 'ss-inst-b-0001', 'open', c);
    expect(await run()).toBe(1);
    const row = await contactRow(c);
    expect(row['photo_key']).toBeNull();
    expect(row['photo_checked_at']).not.toBeNull();
    expect(await run()).toBe(0);
    await admin.query(`UPDATE contacts SET photo_checked_at = now() - interval '8 days' WHERE id = $1`, [c]);
    expect(await run()).toBe(1);
  });

  it('una imagen no admisible (otro formato o el descargador la rechaza) no se guarda', async () => {
    const c = await insertContact(ORG_A, 'Rara', '+593990000012', IDS.carol);
    await qrChannel(ORG_A, 'ss-inst-c-0001', 'open', c);
    qr.pictures.set('593990000012', 'https://pps.whatsapp.net/v/rara.gif');
    downloader().download = () => Promise.resolve(GIF);
    await run();
    expect((await contactRow(c))['photo_key']).toBeNull();
    expect(storage.fake.objects.size).toBe(0);
  });

  it('con la sesión caída o el almacenamiento sin responder NO se anota nada (se reintenta en la vuelta siguiente)', async () => {
    const down = await insertContact(ORG_A, 'Caída', '+593990000013', IDS.carol);
    await qrChannel(ORG_A, 'ss-inst-d-0001', 'closed', down);
    await run();
    expect((await contactRow(down))['photo_checked_at']).toBeNull();

    const ok = await insertContact(ORG_A, 'Almacén', '+593990000014', IDS.carol);
    await qrChannel(ORG_A, 'ss-inst-e-0001', 'open', ok);
    qr.pictures.set('593990000014', 'https://pps.whatsapp.net/v/almacen.jpg');
    downloader().download = () => Promise.resolve(PNG);
    storage.fake.down = true;
    await run();
    expect((await contactRow(ok))['photo_checked_at']).toBeNull();
    storage.fake.down = false;
    expect(await run()).toBeGreaterThanOrEqual(1);
    expect((await contactRow(ok))['photo_key']).not.toBeNull();
  });

  it('A↔B: cada empresa usa su sesión y guarda bajo su propio prefijo; un contacto sin conversación QR no se consulta', async () => {
    const a = await insertContact(ORG_A, 'De A', '+593990000015', IDS.carol);
    const b = await insertContact(ORG_B, 'De B', '+593990000016', IDS.bob);
    const loose = await insertContact(ORG_A, 'Suelto', '+593990000017', IDS.carol);
    await qrChannel(ORG_A, 'ss-inst-f-0001', 'open', a);
    await qrChannel(ORG_B, 'ss-inst-g-0001', 'open', b);
    qr.pictures.set('593990000015', 'https://pps.whatsapp.net/v/a.jpg');
    qr.pictures.set('593990000016', 'https://pps.whatsapp.net/v/b.jpg');
    downloader().download = () => Promise.resolve(JPEG);
    await run();
    expect((await contactRow(a))['photo_key']).toMatch(new RegExp(`^org/${ORG_A}/`));
    expect((await contactRow(b))['photo_key']).toMatch(new RegExp(`^org/${ORG_B}/`));
    expect((await contactRow(loose))['photo_checked_at']).toBeNull();
  });
});
