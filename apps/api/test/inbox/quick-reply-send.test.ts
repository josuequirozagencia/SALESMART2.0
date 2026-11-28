// V25 · 25.3 — Adjuntos en las respuestas rápidas. Ruta cubierta (el registro de endpoints exige que este archivo la escriba tal cual):
//   POST /v1/conversations/:id/quick-replies/:replyId/send
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { LibraryModule } from '../../src/modules/library';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { QuickRepliesModule } from '../../src/modules/quick-replies';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, InboxModule, LibraryModule, QuickRepliesModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A, dueña de la conversación
  eve: 'e0000000-0000-4000-8000-0000000000e5', // otra asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(Date.now() - ms);

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob', string>;
let channelA = '';
let channelB = '';
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE quick_reply_sends, quick_reply_assets, quick_replies, response_timers, member_permissions, media_assets, media_folders, message_attachments, messages, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
async function connect(token: string, phoneId: string, name: string, waba = '1234567890123'): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: waba, phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

let seq = 0;
async function mkConv(o: { owner?: string | null; org?: string; lastInbound?: Date | null } = {}): Promise<string> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const phone = `+59398700${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  return (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'working', $4, $5, $6, $7, 1, $8) RETURNING id`, [org, contact, org === ORG_B ? channelB : channelA, owner, owner ? new Date() : null, ago(30 * MIN), o.lastInbound === undefined ? ago(HOUR) : o.lastInbound, phone.slice(1)])).rows[0].id as string;
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 5)]);
interface Asset { id: string; usable_by_advisors: boolean }
interface ChatMsg { id: string; kind: string; text: string | null; attachment: { id: string; kind: string } | null; status: string }
const asset = async (token: string, name = 'foto.jpg'): Promise<Asset> => {
  const r = await fetch(`${base}/library/assets`, { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-filename': encodeURIComponent(name), authorization: `Bearer ${token}` }, body: JPEG });
  expect(r.status).toBe(201);
  return json<Asset>(r);
};

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'REQUIRE_VIRUS_SCAN']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AUDIO_TRANSCODER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test') };
  channelA = await connect(T.alice, '1090123456789', 'Ventas');
  channelB = await connect(T.bob, '1090123456780', 'Soporte', '1234567890124');
});

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 7)]);
const audio = async (token: string, name = 'saludo.mp3'): Promise<Asset> => {
  const r = await fetch(`${base}/library/assets`, { method: 'POST', headers: { 'content-type': 'audio/mpeg', 'x-filename': encodeURIComponent(name), authorization: `Bearer ${token}` }, body: MP3 });
  expect(r.status, await r.clone().text()).toBe(201);
  return json<Asset>(r);
};
interface Reply { id: string; shared: boolean; assets: Array<{ id: string; kind: string; size_bytes: number; name: string | null; problem: string | null }>; text?: string }
let shortcuts = 0;
const createReply = (token: string, body: Record<string, unknown> = {}) => call('POST', '/quick-replies', token, { shortcut: `r${(shortcuts += 1)}`, body: 'Hola {{primer_nombre}}', ...body });
const reply = async (token: string, body: Record<string, unknown> = {}): Promise<Reply> => {
  const r = await createReply(token, body);
  expect(r.status, await r.clone().text()).toBe(201);
  return json<Reply>(r);
};
const sendReply = (token: string | undefined, conv: string, id: string, body: unknown = { text: 'Hola Ana' }, key: string | null = `k-${randomUUID()}`) =>
  fetch(`${base}/conversations/${conv}/quick-replies/${id}/send`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
const errorOf = async (r: Response) => (await json<{ error: { code: string; message: string; details?: Array<{ message: string }> } }>(r)).error;
const outbound = async (conv: string) => (await admin.query(`SELECT m.kind, m.body, m.status, m.sender_type, m.created_by, a.id AS attachment_id, a.storage_key FROM messages m LEFT JOIN message_attachments a ON a.message_id = m.id WHERE m.conversation_id = $1 AND m.direction = 'out' AND m.kind <> 'note' ORDER BY m.sent_at, m.id`, [conv])).rows as Array<Record<string, unknown>>;
const rowsOf = async (table: string) => (await admin.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number;

describe('archivos de una respuesta rápida', () => {
  it('se guardan en orden con nombre en la configuración, se reordenan y nunca pasan de 3 (tampoco en la base)', async () => {
    const [a, b, c, d] = [await asset(T.alice, 'uno.jpg'), await asset(T.alice, 'dos.jpg'), await asset(T.alice, 'tres.jpg'), await asset(T.alice, 'cuatro.jpg')];
    const r = await reply(T.alice, { shared: true, asset_ids: [a.id, b.id] });
    expect(r.assets.map((x) => [x.name, x.kind, x.problem])).toEqual([['uno.jpg', 'image', null], ['dos.jpg', 'image', null]]);
    const upd = await call('PATCH', `/quick-replies/${r.id}`, T.alice, { asset_ids: [c.id, a.id, b.id] });
    expect((await json<Reply>(upd)).assets.map((x) => x.id)).toEqual([c.id, a.id, b.id]);
    expect((await createReply(T.alice, { asset_ids: [a.id, b.id, c.id, d.id] })).status).toBe(400);
    expect((await createReply(T.alice, { asset_ids: [a.id, a.id] })).status).toBe(400);
    for (const position of [3, 0]) await expect(admin.query(`INSERT INTO quick_reply_assets(organization_id, quick_reply_id, asset_id, position) VALUES ($1,$2,$3,$4)`, [ORG_A, r.id, d.id, position])).rejects.toThrow();
    expect((await json<Reply>(await call('PATCH', `/quick-replies/${r.id}`, T.alice, { asset_ids: [] }))).assets).toEqual([]);
  });

  it('aislamiento A↔B: no se puede enlazar un archivo de otra empresa, ni forzándolo en la base', async () => {
    const mine = await asset(T.alice);
    const other = await asset(T.bob, 'ajena.jpg');
    const r = await createReply(T.alice, { asset_ids: [other.id] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).not.toContain('ajena');
    const ok = await reply(T.alice, { asset_ids: [mine.id] });
    await expect(admin.query(`INSERT INTO quick_reply_assets(organization_id, quick_reply_id, asset_id, position) VALUES ($1,$2,$3,1)`, [ORG_A, ok.id, other.id])).rejects.toThrow(/quick_reply_assets_asset_fk/);
    expect((await call('PATCH', `/quick-replies/${ok.id}`, T.bob, { asset_ids: [other.id] })).status).toBe(404);
  });

  it('la asesora solo elige lo marcado para asesores; compartida exige archivos para asesores y lo dice con el nombre; un archivo archivado no se guarda', async () => {
    const secret = await asset(T.alice, 'interno.jpg');
    expect((await call('PATCH', `/library/assets/${secret.id}`, T.alice, { usable_by_advisors: false })).status).toBe(200);
    expect((await createReply(T.carol, { asset_ids: [secret.id] })).status).toBe(400);
    const shared = await createReply(T.alice, { shared: true, asset_ids: [secret.id] });
    expect(shared.status).toBe(409);
    expect(await errorOf(shared)).toMatchObject({ code: 'QUICK_REPLY_ASSET_NOT_SHARED', message: expect.stringContaining('interno.jpg') });
    const personal = await reply(T.alice, { asset_ids: [secret.id] });
    expect((await errorOf(await call('PATCH', `/quick-replies/${personal.id}`, T.alice, { shared: true }))).code).toBe('QUICK_REPLY_ASSET_NOT_SHARED');
    const gone = await asset(T.alice, 'viejo.jpg');
    await call('POST', `/library/assets/${gone.id}/archive`, T.alice);
    expect((await errorOf(await createReply(T.alice, { asset_ids: [gone.id] }))).code).toBe('QUICK_REPLY_ASSET_UNAVAILABLE');
  });

  it('en la conversación los archivos van sin nombre; sin permiso de biblioteca no aparecen y no se pueden enlazar', async () => {
    const a = await asset(T.alice, 'catalogo.jpg');
    await reply(T.alice, { shared: true, asset_ids: [a.id] });
    const conv = await mkConv();
    const list = await json<{ items: Reply[] }>(await call('GET', `/conversations/${conv}/quick-replies`, T.carol));
    expect(list.items[0]!.assets).toEqual([{ id: a.id, kind: 'image', size_bytes: expect.any(Number), name: null, usable_by_advisors: true, problem: null }]);
    expect(JSON.stringify(list)).not.toContain('catalogo');
    await admin.query(`INSERT INTO member_permissions(id, membership_id, permission_key, effect) SELECT gen_random_uuid(), id, 'library.read', 'deny' FROM organization_members WHERE user_id = $1`, [IDS.carol]);
    const without = await json<{ items: Reply[] }>(await call('GET', `/conversations/${conv}/quick-replies`, T.carol));
    expect(without.items[0]).toMatchObject({ assets: [] });
    expect((await createReply(T.carol, { asset_ids: [a.id] })).status).toBe(403);
    expect((await createReply(T.carol)).status).toBe(201);
    expect((await sendReply(T.carol, conv, list.items[0]!.id)).status).toBe(403);
  });

  it('el uso de un archivo nombra las respuestas compartidas y de las personales solo dice cuántas', async () => {
    const a = await asset(T.alice);
    const s = await reply(T.alice, { shortcut: 'precios', shared: true, asset_ids: [a.id] });
    await reply(T.carol, { shortcut: 'secreta', asset_ids: [a.id] });
    await reply(T.alice, { shortcut: 'mia', asset_ids: [a.id] });
    const borrada = await reply(T.alice, { shortcut: 'borrada', shared: true, asset_ids: [a.id] });
    await call('DELETE', `/quick-replies/${borrada.id}`, T.alice);
    const u = await json(await call('GET', `/library/assets/${a.id}/usage`, T.alice));
    expect(u).toEqual({ automations: [], quick_replies: [{ id: s.id, shortcut: 'precios' }], personal_quick_replies: 2 });
    expect(JSON.stringify(u)).not.toContain('secreta');
  });
});

describe('enviar una respuesta rápida', () => {
  it('sale en orden con el texto como pie del primer archivo, copias propias, como mensajes humanos que detienen el SLA', async () => {
    const [a, b] = [await asset(T.alice, 'uno.jpg'), await asset(T.alice, 'dos.jpg')];
    const r = await reply(T.alice, { shared: true, asset_ids: [a.id, b.id] });
    const conv = await mkConv();
    await admin.query(`INSERT INTO response_timers(id, organization_id, conversation_id, kind, owner_id, started_at, due_at) VALUES (gen_random_uuid(), $1, $2, 'first', $3, now() - interval '5 minutes', now() + interval '5 minutes')`, [ORG_A, conv, IDS.carol]);
    const res = await sendReply(T.carol, conv, r.id, { text: 'Hola Ana, mira' });
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await json<{ messages: ChatMsg[] }>(res)).messages.map((m) => [m.kind, m.text, m.status])).toEqual([['image', 'Hola Ana, mira', 'sent'], ['image', null, 'sent']]);
    const rows = await outbound(conv);
    expect(rows.map((m) => [m['sender_type'], m['created_by']])).toEqual([['human', IDS.carol], ['human', IDS.carol]]);
    for (const m of rows) expect(String(m['storage_key'])).toMatch(new RegExp(`^org/${ORG_A}/attachments/`));
    expect((await admin.query(`SELECT stopped_at IS NOT NULL AS s FROM response_timers WHERE conversation_id = $1`, [conv])).rows[0].s).toBe(true);
    expect((await admin.query(`SELECT status FROM conversations WHERE id = $1`, [conv])).rows[0].status).toBe('waiting');
    const audit = (await admin.query(`SELECT new_value, actor_user_id FROM audit_logs WHERE entity_type = 'conversation' AND field = 'quick_reply'`)).rows;
    expect(audit).toEqual([{ actor_user_id: IDS.carol, new_value: { quick_reply_id: r.id, files: 2, kinds: ['image', 'image'] } }]);
    expect(JSON.stringify(audit)).not.toContain('Hola');
  });

  it('con un audio primero sale el audio y luego el texto aparte; un texto largo sale antes que los archivos; se puede quitar un archivo o mandarlos sin texto', async () => {
    const voice = await audio(T.alice);
    const img = await asset(T.alice);
    const r = await reply(T.alice, { shared: true, asset_ids: [voice.id, img.id] });
    const c1 = await mkConv();
    expect((await sendReply(T.carol, c1, r.id, { text: 'Escucha' })).status).toBe(201);
    expect((await outbound(c1)).map((m) => [m['kind'], m['body']])).toEqual([['audio', null], ['text', 'Escucha'], ['image', null]]);
    const c2 = await mkConv();
    const long = 'x'.repeat(1500);
    expect((await sendReply(T.carol, c2, r.id, { text: long, asset_ids: [img.id] })).status).toBe(201);
    expect((await outbound(c2)).map((m) => [m['kind'], (m['body'] as string | null)?.length ?? null])).toEqual([['text', 1500], ['image', null]]);
    const c3 = await mkConv();
    expect((await sendReply(T.carol, c3, r.id, { asset_ids: [img.id] })).status).toBe(201);
    expect((await outbound(c3)).map((m) => [m['kind'], m['body']])).toEqual([['image', null]]);
    const c4 = await mkConv();
    expect((await sendReply(T.carol, c4, r.id, { text: 'Solo texto', asset_ids: [] })).status).toBe(201);
    expect((await outbound(c4)).map((m) => m['kind'])).toEqual(['text']);
  });

  it('la llave es obligatoria; repetirla no duplica (también a la vez) y con otros datos se rechaza', async () => {
    const a = await asset(T.alice);
    const r = await reply(T.alice, { shared: true, asset_ids: [a.id] });
    const conv = await mkConv();
    expect((await sendReply(T.carol, conv, r.id, { text: 'Hola' }, null)).status).toBe(400);
    const key = 'k-repetida-0001';
    const [one, two] = await Promise.all([sendReply(T.carol, conv, r.id, { text: 'Hola' }, key), sendReply(T.carol, conv, r.id, { text: 'Hola' }, key)]);
    expect([one.status, two.status].sort()).toEqual([200, 201]);
    const again = await sendReply(T.carol, conv, r.id, { text: 'Hola' }, key);
    expect(again.status).toBe(200);
    expect(await outbound(conv)).toHaveLength(1);
    expect(await rowsOf('message_attachments')).toBe(1);
    expect((await errorOf(await sendReply(T.carol, conv, r.id, { text: 'Otra cosa' }, key))).code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('si un archivo se archivó no sale nada (ni el texto) y dice cuál sin nombrarlo; quitándolo, el resto sí sale', async () => {
    const [a, b] = [await asset(T.alice, 'sigue.jpg'), await asset(T.alice, 'caducado.jpg')];
    const r = await reply(T.alice, { shared: true, asset_ids: [a.id, b.id] });
    await call('POST', `/library/assets/${b.id}/archive`, T.alice);
    const conv = await mkConv();
    const res = await sendReply(T.carol, conv, r.id, { text: 'Hola' });
    expect(res.status).toBe(409);
    const e = await errorOf(res);
    expect(e).toMatchObject({ code: 'QUICK_REPLY_ASSET_UNAVAILABLE', details: [{ message: b.id }] });
    expect(e.message).not.toContain('caducado');
    expect(await outbound(conv)).toEqual([]);
    expect(await rowsOf('message_attachments')).toBe(0);
    expect((await sendReply(T.carol, conv, r.id, { text: 'Hola', asset_ids: [a.id] })).status).toBe(201);
  });

  it('un archivo que dejó de ser para asesores ya no lo puede enviar la asesora, pero sí el administrador', async () => {
    const a = await asset(T.alice);
    const r = await reply(T.alice, { shared: true, asset_ids: [a.id] });
    await call('PATCH', `/library/assets/${a.id}`, T.alice, { usable_by_advisors: false });
    const conv = await mkConv();
    expect((await errorOf(await sendReply(T.carol, conv, r.id))).code).toBe('QUICK_REPLY_ASSET_UNAVAILABLE');
    expect((await sendReply(T.alice, conv, r.id)).status).toBe(201);
  });

  it('valida el texto y los archivos; ventana cerrada 409 sin copiar nada; por GoHighLevel solo texto', async () => {
    const a = await asset(T.alice);
    const other = await asset(T.alice, 'otro.jpg');
    const r = await reply(T.alice, { shared: true, asset_ids: [a.id] });
    const conv = await mkConv();
    expect((await sendReply(T.carol, conv, r.id, { text: 'Hola {{nombre}}' })).status).toBe(400);
    expect((await sendReply(T.carol, conv, r.id, { asset_ids: [other.id] })).status).toBe(400);
    expect((await sendReply(T.carol, conv, r.id, { text: '', asset_ids: [] })).status).toBe(400);
    const closed = await mkConv({ lastInbound: ago(30 * HOUR) });
    expect((await errorOf(await sendReply(T.carol, closed, r.id))).code).toBe('WINDOW_CLOSED');
    expect(await rowsOf('message_attachments')).toBe(0);
    await admin.query(`UPDATE channel_accounts SET provider = 'ghl' WHERE id = $1`, [channelA]);
    expect((await errorOf(await sendReply(T.carol, conv, r.id))).code).toBe('CHANNEL_NO_MEDIA');
    expect((await sendReply(T.carol, conv, r.id, { text: 'Solo texto', asset_ids: [] })).status).toBe(201);
  });

  it('visibilidad y aislamiento: conversación ajena, respuesta personal de otra persona y otra empresa dan 404; sin sesión 401', async () => {
    const a = await asset(T.alice);
    const shared = await reply(T.alice, { shared: true, asset_ids: [a.id] });
    const personal = await reply(T.alice, { asset_ids: [a.id] });
    const conv = await mkConv();
    expect((await sendReply(T.eve, conv, shared.id)).status).toBe(404);
    expect((await sendReply(T.carol, conv, personal.id)).status).toBe(404);
    expect((await sendReply(T.bob, conv, shared.id)).status).toBe(404);
    const theirs = await mkConv({ org: ORG_B, owner: IDS.bob });
    expect((await sendReply(T.bob, theirs, shared.id)).status).toBe(404);
    expect((await sendReply(undefined, conv, shared.id)).status).toBe(401);
    expect(await rowsOf('quick_reply_sends')).toBe(0);
  });
});
