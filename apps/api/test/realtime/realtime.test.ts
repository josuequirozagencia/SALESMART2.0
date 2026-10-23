// M5.7 — Tiempo real del Inbox (ADR-50). Socket.IO en el mismo proceso: la sesión es la misma que la de la API y cada aviso llega solo a quien puede ver la conversación.
// No añade rutas HTTP al registro de endpoints: el transporte vive en /v1/realtime (lo atiende Socket.IO antes de Express).
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { io as connectIo, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { clientIp, MAX_SOCKETS_PER_USER, REALTIME_PATH, RealtimeService, type RealtimeEnvelope } from '../../src/modules/realtime';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, InboxModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a',
  carol: 'c0000000-0000-4000-8000-0000000000c3',
  eve: 'e0000000-0000-4000-8000-0000000000e5',
  bob: 'b0000000-0000-4000-8000-00000000000b',
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const KEY = randomBytes(32).toString('base64');

let admin: Client;
let app: INestApplication;
let origin = '';
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob' | 'root', string>;
let channelA = '';
let rt: RealtimeService;
const saved = { ...process.env };
const open: Socket[] = [];

async function start(): Promise<void> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY, WHATSAPP_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AUDIO_TRANSCODER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
  base = `${origin}/v1`;
  rt = app.get(RealtimeService);
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE message_attachments, messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
async function connectChannel(token: string, phoneId: string, name: string, waba = '1234567890123'): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: waba, phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

let seq = 0;
async function mkConv(owner: string | null, org = ORG_A): Promise<string> {
  seq += 1;
  const phone = `+59398800${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  const channel = org === ORG_A ? channelA : (await admin.query(`SELECT id FROM channel_accounts WHERE organization_id = $1 LIMIT 1`, [org])).rows[0]?.id;
  return (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, unread_count, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now(), 1, $6) RETURNING id`, [org, contact, channel, owner ? 'working' : 'unassigned', owner, phone.replace('+', '')])).rows[0].id as string;
}

/** Abre una conexión con el token dado; resuelve al conectar o rechaza con el mensaje de error del handshake. */
function connect(token: string | undefined, opts: { query?: Record<string, string> } = {}): Promise<Socket> {
  const socket = connectIo(origin, { path: REALTIME_PATH, transports: ['websocket'], reconnection: false, forceNew: true, auth: token ? { token } : {}, ...(opts.query ? { query: opts.query } : {}) });
  open.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (e) => { socket.close(); reject(e); });
  });
}
/** Junta lo que llegue por la conexión durante `ms` (para comprobar tanto lo que SÍ llega como lo que NO). */
function listen(socket: Socket, events: readonly string[]): Array<{ event: string; body: RealtimeEnvelope }> {
  const got: Array<{ event: string; body: RealtimeEnvelope }> = [];
  for (const event of events) socket.on(event, (body: RealtimeEnvelope) => got.push({ event, body }));
  return got;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EVENTS = ['conversation.created', 'conversation.updated', 'message.created', 'message.updated', 'scheduled.updated'] as const;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  await start();
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), eve: await login('eve@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
  channelA = await connectChannel(T.alice, '1090123456789', 'Ventas');
  await connectChannel(T.bob, '1090123456780', 'Soporte', '1234567890124');
});
afterEach(() => { while (open.length > 0) open.pop()?.close(); });

describe('conexión', () => {
  it('sin token, con un token inventado o con el token en la URL: el handshake se rechaza', async () => {
    await expect(connect(undefined)).rejects.toThrow('unauthorized');
    await expect(connect('ss_no-es-un-token')).rejects.toThrow('unauthorized');
    await expect(connect(undefined, { query: { token: T.carol } })).rejects.toThrow('unauthorized');
    expect(rt.connections()).toBe(0);
  });

  it('con una sesión vigente conecta; tras cerrar sesión, la siguiente comprobación la desconecta y avisa', async () => {
    const s = await connect(T.carol);
    expect(rt.connections()).toBe(1);
    let expired = false;
    s.on('auth.expired', () => { expired = true; });
    const closed = new Promise<void>((resolve) => s.once('disconnect', () => resolve()));
    expect((await call('POST', '/auth/logout', T.carol, {})).status).toBeLessThan(300);
    await (rt as unknown as { revalidate(): Promise<void> }).revalidate();
    await closed;
    expect(expired).toBe(true);
  });

  it(`como mucho ${MAX_SOCKETS_PER_USER} conexiones por persona: al abrir otra se cierra la más antigua`, async () => {
    const first = await connect(T.carol);
    const gone = new Promise<void>((resolve) => first.once('disconnect', () => resolve()));
    for (let i = 0; i < MAX_SOCKETS_PER_USER; i++) await connect(T.carol);
    await gone;
    expect(first.connected).toBe(false);
    await sleep(100);
    expect(rt.connections()).toBe(MAX_SOCKETS_PER_USER);
  });

  it('clientIp respeta los saltos de proxy de confianza y no se deja engañar por cabeceras que el cliente añade', () => {
    const req = (xff: string | undefined, remote = '10.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } }) as never;
    expect(clientIp(req(undefined), 0)).toBe('10.0.0.1');
    expect(clientIp(req('1.1.1.1'), 0)).toBe('10.0.0.1'); // sin proxy de confianza no se mira la cabecera
    expect(clientIp(req('9.9.9.9, 203.0.113.7'), 1)).toBe('203.0.113.7'); // lo que añadió el proxy, no lo que escribió el cliente
    expect(clientIp(req('9.9.9.9, 203.0.113.7, 10.1.1.1'), 2)).toBe('203.0.113.7');
    expect(clientIp(req('203.0.113.7'), 2)).toBe('203.0.113.7');
  });
});

describe('quién recibe cada aviso', () => {
  it('llega al dueño y a quien ve todo; NO a otro asesor ni a otra empresa; el aviso lleva solo identificadores', async () => {
    const conv = await mkConv(IDS.carol);
    const [carol, alice, eve, bob] = [await connect(T.carol), await connect(T.alice), await connect(T.eve), await connect(T.bob)];
    const got = { carol: listen(carol, EVENTS), alice: listen(alice, EVENTS), eve: listen(eve, EVENTS), bob: listen(bob, EVENTS) };
    rt.touch(ORG_A, conv, { message: { id: 'a0a0a0a0-0000-4000-8000-000000000001', kind: 'created' } });
    await sleep(900);
    for (const who of ['carol', 'alice'] as const) {
      expect(got[who].map((g) => g.event).sort(), who).toEqual(['conversation.updated', 'message.created']);
      for (const g of got[who]) {
        expect(g.body.organization_id).toBe(ORG_A);
        expect(Object.keys(g.body).sort()).toEqual(['at', 'data', 'organization_id', 'request_id']);
        expect(g.body.data.conversation_id).toBe(conv);
      }
      expect(got[who].find((g) => g.event === 'message.created')?.body.data.message_id).toBe('a0a0a0a0-0000-4000-8000-000000000001');
    }
    expect(got.eve).toEqual([]);
    expect(got.bob).toEqual([]);
  });

  it('un colaborador vigente también se entera; uno retirado deja de recibir', async () => {
    const conv = await mkConv(IDS.carol);
    const part = (await admin.query(`INSERT INTO conversation_participants(id, organization_id, conversation_id, user_id, permission, added_by, added_at) VALUES (gen_random_uuid(), $1, $2, $3, 'view', $4, now()) RETURNING id`, [ORG_A, conv, IDS.eve, IDS.alice])).rows[0].id as string;
    const eve = await connect(T.eve);
    const got = listen(eve, EVENTS);
    rt.touch(ORG_A, conv);
    await sleep(900);
    expect(got.map((g) => g.event)).toEqual(['conversation.updated']);
    await admin.query(`UPDATE conversation_participants SET revoked_at = now(), revoked_by = $2 WHERE id = $1`, [part, IDS.alice]);
    got.length = 0;
    rt.touch(ORG_A, conv);
    await sleep(900);
    // Se le avisa una última vez de que cambió (ya no la ve: al volver a pedirla recibe 404 y la saca de su lista); después, nada
    expect(got.length).toBeLessThanOrEqual(1);
    got.length = 0;
    rt.touch(ORG_A, conv);
    await sleep(900);
    expect(got).toEqual([]);
  });

  it('quien la tenía antes de transferirla recibe el aviso del cambio', async () => {
    const conv = await mkConv(IDS.carol);
    const carol = await connect(T.carol);
    const eve = await connect(T.eve);
    const gotCarol = listen(carol, EVENTS);
    const gotEve = listen(eve, EVENTS);
    rt.touch(ORG_A, conv); // primer aviso: se recuerda que Carol la veía
    await sleep(900);
    expect(gotCarol).toHaveLength(1);
    expect(gotEve).toHaveLength(0);
    await admin.query(`UPDATE conversations SET owner_id = $2 WHERE id = $1`, [conv, IDS.eve]);
    gotCarol.length = 0;
    rt.touch(ORG_A, conv);
    await sleep(900);
    expect(gotEve.map((g) => g.event)).toEqual(['conversation.updated']);
    expect(gotCarol.map((g) => g.event)).toEqual(['conversation.updated']); // para que la saque de su lista
  });

  it('una conversación de otra empresa nunca llega: con el identificador de la de A y la empresa B no hay a quién avisar', async () => {
    const conv = await mkConv(IDS.carol);
    const bob = await connect(T.bob);
    const got = listen(bob, EVENTS);
    rt.touch(ORG_B, conv);
    await sleep(900);
    expect(got).toEqual([]);
  });

  it('el soporte del Súper Admin (sin membresía en la empresa) no recibe avisos de ella', async () => {
    const conv = await mkConv(IDS.carol);
    const root = await connect(T.root);
    const got = listen(root, EVENTS);
    rt.touch(ORG_A, conv);
    await sleep(900);
    expect(got).toEqual([]);
  });

  it('una ráfaga se junta: varios avisos de la misma conversación llegan como uno de conversación y uno por mensaje', async () => {
    const conv = await mkConv(IDS.carol);
    const carol = await connect(T.carol);
    const got = listen(carol, EVENTS);
    const id = (n: number) => `a0a0a0a0-0000-4000-8000-00000000000${n}`;
    rt.touch(ORG_A, conv, { message: { id: id(1), kind: 'created' } });
    rt.touch(ORG_A, conv, { message: { id: id(1), kind: 'updated' } }); // sigue contando como creado
    rt.touch(ORG_A, conv, { message: { id: id(2), kind: 'updated' } });
    rt.touch(ORG_A, conv, { scheduled: true });
    await sleep(900);
    expect(got.map((g) => g.event).sort()).toEqual(['conversation.updated', 'message.created', 'message.updated', 'scheduled.updated']);
  });
});

describe('desde la API', () => {
  it('una acción hecha desde la pantalla (marcar leída) avisa al dueño y a quien ve todo, y no a otro asesor', async () => {
    const conv = await mkConv(IDS.carol);
    const [carol, alice, eve] = [await connect(T.carol), await connect(T.alice), await connect(T.eve)];
    const got = { carol: listen(carol, EVENTS), alice: listen(alice, EVENTS), eve: listen(eve, EVENTS) };
    const r = await call('POST', `/conversations/${conv}/read`, T.carol, {});
    expect(r.status).toBeLessThan(300);
    await sleep(900);
    expect(got.carol.map((g) => g.event)).toEqual(['conversation.updated']);
    expect(got.alice.map((g) => g.event)).toEqual(['conversation.updated']);
    expect(got.eve).toEqual([]);
  });

  it('una acción que falla (conversación ajena: 404) no avisa a nadie', async () => {
    const conv = await mkConv(IDS.carol);
    const alice = await connect(T.alice);
    const got = listen(alice, EVENTS);
    const r = await call('POST', `/conversations/${conv}/read`, T.eve, {});
    expect(r.status).toBe(404);
    await sleep(700);
    expect(got).toEqual([]);
  });

  it('el aviso de un mensaje entrante llega por el mismo camino que el resto de la app (ingesta)', async () => {
    // La ingesta usa `touchHere` dentro del contexto de la empresa; aquí se comprueba que sin contexto no avisa a nadie (no inventa empresa)
    const conv = await mkConv(IDS.carol);
    const carol = await connect(T.carol);
    const got = listen(carol, EVENTS);
    rt.touchHere(conv);
    await sleep(700);
    expect(got).toEqual([]);
  });
});
