// F1 — Menciones «@» en notas internas y centro de avisos (ADR-57). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/notifications
//   POST /v1/notifications/read-all
//   POST /v1/notifications/:id/read
//   GET /v1/conversations/:id/mention-options
//   POST /v1/conversations/:id/notes
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
import { ChannelsModule, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider, WHATSAPP_PROVIDER } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { READ_ONLY_PERMISSIONS, ROLE_PERMISSIONS } from '../../src/rbac';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, OpportunitiesModule, ChannelsModule, QueuesModule, InboxModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  eve: 'e0000000-0000-4000-8000-0000000000e5', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const NOBODY = '11111111-1111-4111-8111-111111111111';
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): Date => new Date(Date.now() - ms);

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'eve' | 'bob' | 'root', string>;
let channelA = '';
let channelB = '';
const saved = { ...process.env };

async function start(): Promise<void> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE notifications, message_mentions, scheduled_messages, response_timers, messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.eve, 'eve@a.test', 'Eva Mora'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.eve, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};
async function connect(token: string, phoneId: string, name: string, waba = '1234567890123'): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: waba, phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}


let seq = 0;
async function mkConv(o: { owner?: string | null; status?: string; org?: string; lastInbound?: Date | null } = {}): Promise<string> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const status = o.status ?? (owner ? 'working' : 'unassigned');
  const phone = `+59398700${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  return (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 1, $9) RETURNING id`,
      [org, contact, org === ORG_B ? channelB : channelA, status, owner, owner ? new Date() : null, ago(30 * MIN), o.lastInbound === undefined ? ago(HOUR) : o.lastInbound, phone.slice(1)],
    )
  ).rows[0].id as string;
}
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;

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
  channelA = await connect(T.alice, '1090123456789', 'Ventas');
  channelB = await connect(T.bob, '1090123456780', 'Soporte', '1234567890124');
  fake().outbox.length = 0;
});

// ═════════════════════════════════════════════════════════════════════════════
interface Notice { id: string; type: 'mention'; created_at: string; read_at: string | null; actor: { id: string; name: string } | null; conversation: { id: string; contact: { id: string; name: string } }; message_id: string | null; excerpt: string | null }
interface NoticePage { items: Notice[]; next_cursor: string | null; unread: number | null }
interface Opt { id: string; name: string; can_view: boolean }
interface NoteView { id: string; kind: string; text: string; is_note: boolean; mentions: Array<{ user_id: string; name: string }> }

const notices = async (token: string, qs = ''): Promise<NoticePage> => ok<NoticePage>(await call('GET', `/notifications${qs}`, token));
const note = (token: string, conv: string, text: string, mentions?: string[]) => call('POST', `/conversations/${conv}/notes`, token, { text, ...(mentions ? { mentions } : {}) });
const options = async (token: string, conv: string): Promise<Opt[]> => (await ok<{ items: Opt[] }>(await call('GET', `/conversations/${conv}/mention-options`, token))).items;
const share = (conv: string, user: string, permission: 'reply' | 'view' = 'view') =>
  admin.query(`INSERT INTO conversation_participants(id, organization_id, conversation_id, user_id, permission) VALUES (gen_random_uuid(), $1, $2, $3, $4)`, [ORG_A, conv, user, permission]);
const revokeShare = (conv: string) => admin.query(`UPDATE conversation_participants SET revoked_at = now(), revoked_by = $1 WHERE conversation_id = $2`, [IDS.alice, conv]);
const counts = async () => (await admin.query(`SELECT (SELECT count(*)::int FROM messages WHERE kind = 'note') AS notes, (SELECT count(*)::int FROM message_mentions) AS mentions, (SELECT count(*)::int FROM notifications) AS notices`)).rows[0] as { notes: number; mentions: number; notices: number };

describe('acceso y aislamiento', () => {
  it('sin sesión 401 y la plataforma 403 en todas las rutas', async () => {
    const conv = await mkConv();
    const routes: Array<[string, string, unknown?]> = [['GET', '/notifications'], ['POST', '/notifications/read-all'], ['POST', `/notifications/${NOBODY}/read`], ['GET', `/conversations/${conv}/mention-options`], ['POST', `/conversations/${conv}/notes`, { text: 'x' }]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
  });

  it('los permisos: ver los avisos entra en el techo de solo lectura; marcarlos como leídos no', () => {
    expect(READ_ONLY_PERMISSIONS.has('notifications.read')).toBe(true);
    expect(READ_ONLY_PERMISSIONS.has('notifications.write')).toBe(false);
    expect(ROLE_PERMISSIONS.advisor).toEqual(expect.arrayContaining(['notifications.read', 'notifications.write']));
    expect(ROLE_PERMISSIONS.client_admin).toEqual(expect.arrayContaining(['notifications.read', 'notifications.write']));
  });

  it('A↔B: nadie de otra empresa puede mencionar ni ve opciones, y los avisos de A no aparecen en B', async () => {
    const convA = await mkConv({ owner: IDS.carol });
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    expect((await call('GET', `/conversations/${convA}/mention-options`, T.bob)).status).toBe(404);
    expect((await note(T.bob, convA, 'hola', [IDS.alice])).status).toBe(404);
    // desde B no se puede mencionar a una persona de A (ni en su propia conversación)
    expect((await note(T.bob, convB, 'hola', [IDS.alice])).status).toBe(400);
    // las opciones de A no incluyen a nadie de B y viceversa
    expect((await options(T.carol, convA)).map((o) => o.id).sort()).toEqual([IDS.alice, IDS.eve].sort());
    expect((await options(T.bob, convB)).map((o) => o.id)).toEqual([]);
    await ok(await note(T.carol, convA, 'Revisa esto', [IDS.alice]), 201);
    expect((await notices(T.alice)).items).toHaveLength(1);
    expect((await notices(T.bob)).items).toEqual([]);
    expect((await notices(T.bob)).unread).toBe(0);
    // un aviso de A no se puede marcar desde B (404), tampoco por su id
    const id = (await notices(T.alice)).items[0]!.id;
    expect((await call('POST', `/notifications/${id}/read`, T.bob)).status).toBe(404);
    expect((await admin.query(`SELECT read_at FROM notifications WHERE id = $1`, [id])).rows[0].read_at).toBeNull();
  });
});

describe('opciones del selector «@»', () => {
  it('lista a las demás personas con quién ya ve la conversación primero, y compartirla activa a la otra', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    const first = await options(T.carol, conv);
    expect(first).toEqual([
      { id: IDS.alice, name: 'Alicia Torres', can_view: true }, // ve todo
      { id: IDS.eve, name: 'Eva Mora', can_view: false },
    ]);
    await share(conv, IDS.eve, 'view');
    expect((await options(T.carol, conv)).find((o) => o.id === IDS.eve)!.can_view).toBe(true);
    await revokeShare(conv);
    expect((await options(T.carol, conv)).find((o) => o.id === IDS.eve)!.can_view).toBe(false);
  });

  it('quien no ve la conversación (o no existe) recibe 404', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    expect((await call('GET', `/conversations/${conv}/mention-options`, T.eve)).status).toBe(404);
    expect((await call('GET', `/conversations/${NOBODY}/mention-options`, T.alice)).status).toBe(404);
  });
});

describe('mencionar en una nota', () => {
  it('guarda la nota con sus menciones, avisa SOLO a la persona mencionada y devuelve el extracto', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    const r = await ok<NoteView>(await note(T.carol, conv, 'Alicia, ¿puedes aprobar el descuento para este cliente?', [IDS.alice]), 201);
    expect(r).toMatchObject({ kind: 'note', is_note: true, mentions: [{ user_id: IDS.alice, name: 'Alicia Torres' }] });
    const mine = await notices(T.alice);
    expect(mine.unread).toBe(1);
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ type: 'mention', read_at: null, actor: { id: IDS.carol, name: 'Carolina Vera' }, conversation: { id: conv, contact: { name: expect.stringMatching(/^Cliente /) } }, message_id: r.id, excerpt: 'Alicia, ¿puedes aprobar el descuento para este cliente?' });
    // nadie más ve ese aviso: ni quien escribió ni la otra asesora
    expect((await notices(T.carol)).items).toEqual([]);
    expect((await notices(T.eve)).items).toEqual([]);
    // el hilo devuelve las menciones de la nota para resaltarlas
    const thread = await ok<{ items: NoteView[] }>(await call('GET', `/conversations/${conv}/messages`, T.carol));
    expect(thread.items.find((m) => m.id === r.id)!.mentions).toEqual([{ user_id: IDS.alice, name: 'Alicia Torres' }]);
    // el texto del aviso no se copia: no hay columna con el texto
    const cols = (await admin.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications'`)).rows.map((x) => x.column_name as string);
    expect(cols).not.toEqual(expect.arrayContaining(['body']));
    expect(cols).not.toEqual(expect.arrayContaining(['text']));
  });

  it('una nota sin menciones sigue igual y no crea avisos; repetir una persona avisa una sola vez; mencionarse a sí misma no avisa', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    const plain = await ok<NoteView>(await note(T.carol, conv, 'Solo una nota'), 201);
    expect(plain.mentions).toEqual([]);
    expect(await counts()).toEqual({ notes: 1, mentions: 0, notices: 0 });
    const twice = await ok<NoteView>(await note(T.carol, conv, 'Hola', [IDS.alice, IDS.alice, IDS.carol]), 201);
    expect(twice.mentions.map((m) => m.user_id).sort()).toEqual([IDS.alice, IDS.carol].sort());
    expect(await counts()).toEqual({ notes: 2, mentions: 2, notices: 1 }); // a sí misma queda resaltada pero sin aviso
    expect((await notices(T.alice)).items).toHaveLength(1);
    expect((await notices(T.carol)).items).toEqual([]);
  });

  it('rechaza con 400 y NO guarda nada a quien no ve la conversación, a quien no es del equipo, a otra empresa y a más de 10', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    const bad = async (ids: string[], expected: string) => {
      const r = await note(T.carol, conv, 'Nota rechazada', ids);
      expect(r.status, expected).toBe(400);
      const body = await json<{ error: { code: string; details: Array<{ path: string; code: string }> } }>(r);
      expect(body.error.details[0]).toMatchObject({ path: 'mentions', code: expected });
    };
    await bad([IDS.eve], 'cannot_view'); // eve no ve la conversación: compartirla primero
    await bad([IDS.bob], 'not_in_team'); // persona de otra empresa
    await bad([NOBODY], 'not_in_team'); // ni existe
    await bad([IDS.alice, IDS.eve], 'cannot_view'); // una mala invalida toda la nota
    await bad(Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), 'too_many');
    expect(await counts()).toEqual({ notes: 0, mentions: 0, notices: 0 });
    // validación de forma: no es un uuid
    expect((await note(T.carol, conv, 'x', ['no-es-uuid'])).status).toBe(400);
  });

  it('quien ve la conversación por compartirla (con permiso de solo ver) sí se puede mencionar y recibe el aviso', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    await share(conv, IDS.eve, 'view');
    await ok(await note(T.carol, conv, 'Eva, mira esto', [IDS.eve]), 201);
    expect((await notices(T.eve)).items).toHaveLength(1);
    // ... y si se la retiran, el aviso deja de aparecer y de contar (ya no puede abrirla)
    await revokeShare(conv);
    const after = await notices(T.eve);
    expect(after.items).toEqual([]);
    expect(after.unread).toBe(0);
    // el aviso sigue guardado: si se la vuelven a compartir, reaparece
    await share(conv, IDS.eve, 'view');
    expect((await notices(T.eve)).items).toHaveLength(1);
  });

  it('el dueño o quien la comparte puede mencionar al administrador aunque la conversación no sea de él (ve todo)', async () => {
    const conv = await mkConv({ owner: IDS.eve });
    await ok(await note(T.eve, conv, 'Aviso al administrador', [IDS.alice]), 201);
    expect((await notices(T.alice)).items[0]!.conversation.id).toBe(conv);
  });

  it('un contacto borrado oculta sus avisos', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    await ok(await note(T.carol, conv, 'Hola', [IDS.alice]), 201);
    await admin.query(`UPDATE contacts SET deleted_at = now() WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)`, [conv]);
    const p = await notices(T.alice);
    expect(p.items).toEqual([]);
    expect(p.unread).toBe(0);
  });
});

describe('marcar como leído, lista y paginación', () => {
  it('marca un aviso propio (repetir no cambia la hora), ajeno es 404 y «todo» deja el contador en 0', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    await ok(await note(T.carol, conv, 'Uno', [IDS.alice]), 201);
    await ok(await note(T.carol, conv, 'Dos', [IDS.alice]), 201);
    const list = await notices(T.alice);
    expect(list.unread).toBe(2);
    const first = list.items[0]!;
    expect((await call('POST', `/notifications/${first.id}/read`, T.eve)).status).toBe(404); // ajeno
    expect((await call('POST', `/notifications/${NOBODY}/read`, T.alice)).status).toBe(404);
    const done = await ok<{ id: string; read_at: string }>(await call('POST', `/notifications/${first.id}/read`, T.alice));
    const again = await ok<{ id: string; read_at: string }>(await call('POST', `/notifications/${first.id}/read`, T.alice));
    expect(again.read_at).toBe(done.read_at);
    expect((await notices(T.alice)).unread).toBe(1);
    expect((await notices(T.alice, '?unread=1')).items.map((n) => n.id)).toEqual([list.items[1]!.id]);
    expect((await ok<{ updated: number }>(await call('POST', '/notifications/read-all', T.alice))).updated).toBe(1);
    expect((await notices(T.alice)).unread).toBe(0);
    expect((await notices(T.alice, '?unread=1')).items).toEqual([]);
    // read-all solo toca los propios: los de otra persona siguen sin leer
    await ok(await note(T.carol, conv, 'Para Eva', [IDS.alice]), 201);
    await share(conv, IDS.eve);
    await ok(await note(T.carol, conv, 'Para Eva', [IDS.eve]), 201);
    expect((await ok<{ updated: number }>(await call('POST', '/notifications/read-all', T.alice))).updated).toBe(1);
    expect((await notices(T.eve)).unread).toBe(1);
  });

  it('lo más reciente primero, solo los últimos 90 días y el cursor recorre sin repetir', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    const ids: string[] = [];
    for (let i = 1; i <= 5; i += 1) ids.push((await ok<NoteView>(await note(T.carol, conv, `Nota ${i}`, [IDS.alice]), 201)).id);
    // separar las horas y dejar el aviso 1 con más de 90 días
    for (let i = 0; i < 5; i += 1) await admin.query(`UPDATE notifications SET created_at = now() - ($2 || ' minutes')::interval WHERE message_id = $1`, [ids[i]!, String((5 - i) * 10)]);
    await admin.query(`UPDATE notifications SET created_at = now() - interval '91 days' WHERE message_id = $1`, [ids[0]!]);
    const first = await notices(T.alice, '?limit=2');
    expect(first.items.map((n) => n.message_id)).toEqual([ids[4], ids[3]]); // lo más reciente primero
    expect(first.unread).toBe(4); // el de 91 días no cuenta
    const second = await notices(T.alice, `?limit=2&cursor=${first.next_cursor}`);
    expect(second.items.map((n) => n.message_id)).toEqual([ids[2], ids[1]]);
    expect(second.unread).toBeNull();
    expect(second.next_cursor).toBeNull();
    expect((await call('GET', '/notifications?cursor=zzz', T.alice)).status).toBe(400);
    expect((await call('GET', '/notifications?limit=0', T.alice)).status).toBe(400);
  });

  it('la lista recorta el extracto a 140 caracteres', async () => {
    const conv = await mkConv({ owner: IDS.carol });
    await ok(await note(T.carol, conv, `Hola ${'palabra '.repeat(60)}`, [IDS.alice]), 201);
    const e = (await notices(T.alice)).items[0]!.excerpt!;
    expect(e.length).toBeLessThanOrEqual(140);
    expect(e.endsWith('…')).toBe(true);
  });
});
