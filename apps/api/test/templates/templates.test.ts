// M5.6a — Plantillas de WhatsApp: sincronizar desde Meta, listar y enviar desde una conversación (ADR-50). Rutas cubiertas (el registro de endpoints exige que este archivo
// escriba cada una tal cual):
//   GET /v1/channels/:id/templates
//   POST /v1/channels/:id/templates/sync
//   GET /v1/conversations/:id/templates
//   POST /v1/conversations/:id/template
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
import { ChannelsModule, FAKE_TEMPLATES, FAKE_WHATSAPP_TOKEN, FakeWhatsAppProvider, WHATSAPP_PROVIDER, WhatsAppProviderError } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule, OutboundDispatcher } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
import { Argon2idHasher } from '../../src/security';
import { TemplatesSyncJob } from '../../src/modules/templates';
import { TenantContext } from '../../src/tenant';
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
  await admin.query('TRUNCATE message_templates, response_timers, messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
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
const code = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const ok = async <X,>(r: Response, status = 200): Promise<X> => {
  expect(r.status, JSON.stringify(await r.clone().json().catch(() => null))).toBe(status);
  return json<X>(r);
};
async function connect(token: string, phoneId: string, name: string, waba = '1234567890123'): Promise<string> {
  const r = await call('POST', '/channels', token, { name, waba_id: waba, phone_number_id: phoneId, access_token: FAKE_WHATSAPP_TOKEN });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

interface Tpl { id: string; channel_id: string; name: string; language: string; category: string; status: string; header: { format: string; text: string | null } | null; body: string; footer: string | null; buttons: Array<{ type: string; text: string; url: string | null; phone: string | null }>; variables: Array<{ id: string; part: string; key: string; example: string | null }>; sendable: boolean; unsupported_reason: string | null; rejected_reason: string | null }
interface TplList { items: Tpl[]; synced_at: string | null; sync_error: string | null }
interface Summary { synced_at: string; total: number; added: number; updated: number; removed: number }
interface Msg { id: string; kind: string; text: string | null; status: string; error: string | null; sender_type: string; direction: string; extra: unknown; is_note: boolean; author: { id: string } | null; template: { name: string; language: string; category: string; buttons: Array<{ type: string; text: string; url: string | null }> } | null }

let seq = 0;
async function mkConv(o: { owner?: string | null; status?: string; channel?: string; lastInbound?: Date | null; org?: string } = {}): Promise<string> {
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
      [org, contact, o.channel ?? (org === ORG_B ? channelB : channelA), status, owner, owner ? new Date() : null, ago(30 * MIN), o.lastInbound === undefined ? ago(HOUR) : o.lastInbound, phone.slice(1)],
    )
  ).rows[0].id as string;
}
const fake = (): FakeWhatsAppProvider => app.get(WHATSAPP_PROVIDER, { strict: false }) as FakeWhatsAppProvider;
const sync = async (token: string, channel: string): Promise<Summary> => ok<Summary>(await call('POST', `/channels/${channel}/templates/sync`, token));
const catalog = async (channel: string, token = T.alice): Promise<TplList> => ok<TplList>(await call('GET', `/channels/${channel}/templates`, token));
const byName = (l: TplList, name: string, language = 'es'): Tpl => l.items.find((t) => t.name === name && t.language === language)!;
const sendTpl = (token: string, conv: string, body: unknown) => call('POST', `/conversations/${conv}/template`, token, body);
const convTemplates = (token: string, conv: string) => call('GET', `/conversations/${conv}/templates`, token);
const msgs = async (conv: string) => (await admin.query(`SELECT kind, sender_type, direction, body, status, error, meta, created_by FROM messages WHERE conversation_id = $1 AND kind <> 'note' ORDER BY sent_at, id`, [conv])).rows as Array<{ kind: string; sender_type: string; direction: string; body: string | null; status: string; error: string | null; meta: Record<string, unknown>; created_by: string | null }>;
const convRow = async (id: string) => (await admin.query('SELECT status, owner_id FROM conversations WHERE id = $1', [id])).rows[0] as { status: string; owner_id: string | null };
const tplCount = async (org = ORG_A): Promise<number> => (await admin.query(`SELECT count(*)::int AS n FROM message_templates WHERE organization_id = $1`, [org])).rows[0].n as number;
const dispatch = (org = ORG_A) => TenantContext.run({ organizationId: org }, () => app.get(OutboundDispatcher).runDue(new Date(Date.now() + 5_000)));

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
  const f = fake();
  Reflect.deleteProperty(f, 'listTemplates'); // lo que una prueba haya sustituido vuelve a ser el método real
  f.templates = [...FAKE_TEMPLATES];
  f.listed.length = 0;
  f.outbox.length = 0;
});

// ═════════════════════════════════════════════════════════════════════════════
describe('permisos y aislamiento', () => {
  it('sin sesión 401; la plataforma 403; el asesor no sincroniza ni ve el catálogo de la conexión (403); en una conversación solo quien puede responder', async () => {
    const conv = await mkConv();
    const routes: Array<[string, string, unknown?]> = [['GET', `/channels/${channelA}/templates`], ['POST', `/channels/${channelA}/templates/sync`], ['GET', `/conversations/${conv}/templates`], ['POST', `/conversations/${conv}/template`, { template_id: NOBODY, params: {} }]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
    expect((await call('GET', `/channels/${channelA}/templates`, T.carol)).status).toBe(403);
    expect((await call('POST', `/channels/${channelA}/templates/sync`, T.carol)).status).toBe(403);
    expect(await tplCount()).toBe(0);
  });

  it('A↔B: nadie ve ni sincroniza la conexión de otra empresa, ni lista ni envía plantillas en sus conversaciones (404); cada empresa tiene su catálogo', async () => {
    await sync(T.alice, channelA);
    const convA = await mkConv();
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob, status: 'working' });
    const aTpl = byName(await catalog(channelA), 'bienvenida');
    expect((await call('GET', `/channels/${channelA}/templates`, T.bob)).status).toBe(404);
    expect((await call('POST', `/channels/${channelA}/templates/sync`, T.bob)).status).toBe(404);
    expect((await call('GET', `/channels/${channelB}/templates`, T.alice)).status).toBe(404);
    expect((await convTemplates(T.bob, convA)).status).toBe(404);
    expect((await sendTpl(T.bob, convA, { template_id: aTpl.id, params: {} })).status).toBe(404);
    expect((await convTemplates(T.alice, convB)).status).toBe(404);
    // una plantilla de A no se puede usar en una conversación de B, aunque B la conozca por id (se evita aun siendo de la propia empresa: otra conexión)
    await sync(T.bob, channelB);
    expect((await sendTpl(T.bob, convB, { template_id: aTpl.id, params: {} })).status).toBe(404);
    expect(await tplCount(ORG_A)).toBe(FAKE_TEMPLATES.length);
    expect(await tplCount(ORG_B)).toBe(FAKE_TEMPLATES.length);
    expect(fake().outbox).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('sincronización', () => {
  it('trae todas las plantillas de Meta (aprobadas, pendientes, rechazadas…): primero las enviables, cada una con sus variables, su estado y el motivo si no se puede enviar', async () => {
    const empty = await catalog(channelA);
    expect(empty).toEqual({ items: [], synced_at: null, sync_error: null });
    const r = await sync(T.alice, channelA);
    expect(r).toMatchObject({ total: 10, added: 10, updated: 0, removed: 0 });
    expect(fake().listed).toEqual(['1234567890123']);
    const list = await catalog(channelA);
    expect(list.items).toHaveLength(10);
    expect(list.synced_at).toBe(r.synced_at);
    expect(list.sync_error).toBeNull();
    // las enviables van primero
    const flags = list.items.map((t) => t.sendable);
    expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    expect(list.items.filter((t) => t.sendable).map((t) => `${t.name}/${t.language}`).sort()).toEqual(['bienvenida/en_US', 'bienvenida/es', 'promo_corte/es', 'recordatorio_cita/es', 'seguimiento_nombrado/es']);
    const cita = byName(list, 'recordatorio_cita');
    expect(cita).toMatchObject({ category: 'utility', status: 'approved', sendable: true, unsupported_reason: null, footer: 'Responde para confirmar', channel_id: channelA });
    expect(cita.variables.map((v) => [v.id, v.example])).toEqual([['body:1', 'Ana'], ['body:2', 'viernes 24'], ['body:3', '10:00']]);
    expect(cita.buttons.map((b) => b.text)).toEqual(['Confirmar', 'Reprogramar']);
    expect(byName(list, 'catalogo_imagen')).toMatchObject({ sendable: false, unsupported_reason: 'Lleva una imagen en el encabezado: se podrá usar cuando estén los adjuntos', header: { format: 'image' } });
    expect(byName(list, 'codigo_acceso')).toMatchObject({ sendable: false, category: 'authentication' });
    expect(byName(list, 'en_revision')).toMatchObject({ sendable: false, status: 'pending', unsupported_reason: 'Meta todavía la está revisando' });
    expect(byName(list, 'rechazada_ejemplo')).toMatchObject({ sendable: false, status: 'rejected', rejected_reason: 'Contenido promocional en una plantilla que no es de marketing' });
    expect(byName(list, 'bienvenida', 'en_US').body).toBe('Hello, thanks for writing to us.'); // el mismo nombre en otro idioma es otra plantilla
  });

  it('repetirla no cambia nada (mismos ids, sin altas ni cambios); lo que cambia en Meta se actualiza, lo nuevo se agrega y lo que desaparece se marca borrado (y revive si vuelve)', async () => {
    await sync(T.alice, channelA);
    const first = await catalog(channelA);
    expect(await sync(T.alice, channelA)).toMatchObject({ total: 10, added: 0, updated: 0, removed: 0 });
    expect((await catalog(channelA)).items.map((t) => t.id).sort()).toEqual(first.items.map((t) => t.id).sort());

    // en Meta: se pausa una, se agrega otra y se borra otra
    const f = fake();
    f.templates = f.templates.filter((t) => t.name !== 'rechazada_ejemplo').map((t) => (t.name === 'promo_corte' ? { ...t, status: 'paused' as const } : t));
    f.templates.push({ ...FAKE_TEMPLATES[0]!, externalId: 'tpl-99', name: 'nueva_plantilla', body: { text: 'Hola {{1}}', examples: { '1': 'Ana' } } });
    expect(await sync(T.alice, channelA)).toMatchObject({ total: 10, added: 1, updated: 1, removed: 1 });
    const next = await catalog(channelA);
    expect(next.items.find((t) => t.name === 'rechazada_ejemplo')).toBeUndefined();
    expect(byName(next, 'promo_corte')).toMatchObject({ status: 'paused', sendable: false, unsupported_reason: 'Meta la pausó (suele ser por baja calidad)', id: byName(first, 'promo_corte').id });
    expect(byName(next, 'nueva_plantilla').variables.map((v) => v.id)).toEqual(['body:1']);
    expect((await admin.query(`SELECT deleted_at FROM message_templates WHERE name = 'rechazada_ejemplo'`)).rows[0].deleted_at).not.toBeNull();

    // vuelve a aparecer: revive la misma fila
    f.templates = [...FAKE_TEMPLATES];
    expect(await sync(T.alice, channelA)).toMatchObject({ total: 10, added: 0, updated: 2, removed: 1 }); // revive la rechazada, promo vuelve a aprobada, y desaparece la nueva
    const back = await catalog(channelA);
    expect(byName(back, 'rechazada_ejemplo').id).toBe(byName(first, 'rechazada_ejemplo').id);
    expect(back.items.find((t) => t.name === 'nueva_plantilla')).toBeUndefined();
    expect(await tplCount()).toBe(11); // 10 + la que se agregó y se quitó (conserva su fila marcada)
  });

  it('si Meta rechaza el token, la cuenta no existe o no responde: el error se explica, queda en la conexión, no se pierde lo ya sincronizado y se limpia al volver a funcionar', async () => {
    await sync(T.alice, channelA);
    const f = fake();
    const real = f.listTemplates.bind(f);
    const failWith = (c: 'invalid_token' | 'number_not_found' | 'unavailable' | 'rate_limited') => {
      f.listTemplates = () => Promise.reject(new WhatsAppProviderError(c, 'x'));
    };
    failWith('invalid_token');
    let r = await call('POST', `/channels/${channelA}/templates/sync`, T.alice);
    expect([r.status, await code(r)]).toEqual([409, 'CHANNEL_TOKEN_INVALID']);
    const l = await catalog(channelA);
    expect(l.sync_error).toBe('Meta rechazó el token: genera uno nuevo y pégalo');
    expect(l.items).toHaveLength(10); // lo anterior sigue ahí
    failWith('number_not_found');
    r = await call('POST', `/channels/${channelA}/templates/sync`, T.alice);
    expect([r.status, await code(r)]).toEqual([409, 'CHANNEL_NUMBER_NOT_FOUND']);
    for (const c of ['unavailable', 'rate_limited'] as const) {
      failWith(c);
      r = await call('POST', `/channels/${channelA}/templates/sync`, T.alice);
      expect([r.status, await code(r)], c).toEqual([503, 'CHANNEL_PROVIDER_UNAVAILABLE']);
    }
    f.listTemplates = real;
    await sync(T.alice, channelA);
    expect((await catalog(channelA)).sync_error).toBeNull();
  });

  it('una conexión desconectada no se sincroniza (404); una con id inválido es 400', async () => {
    expect((await call('POST', `/channels/${NOBODY}/templates/sync`, T.alice)).status).toBe(404);
    expect((await call('GET', '/channels/no-es-uuid/templates', T.alice)).status).toBe(400);
    await ok(await call('DELETE', `/channels/${channelA}`, T.alice));
    expect((await call('POST', `/channels/${channelA}/templates/sync`, T.alice)).status).toBe(404);
  });

  it('la tarea periódica sincroniza cada conexión activa bajo su propia empresa; una que falla no frena a las demás', async () => {
    const job = app.get(TemplatesSyncJob);
    expect(job.name).toBe('templates-sync');
    expect(await job.run()).toBe(2);
    expect(await tplCount(ORG_A)).toBe(10);
    expect(await tplCount(ORG_B)).toBe(10);
    // A falla; B sigue sincronizando
    const f = fake();
    const real = f.listTemplates.bind(f);
    f.listTemplates = (c, w) => (w === '1234567890123' ? Promise.reject(new WhatsAppProviderError('unavailable', 'x')) : real(c, w));
    f.templates = f.templates.slice(0, 5);
    expect(await job.run()).toBe(1);
    f.listTemplates = real;
    expect([await tplCount(ORG_A), (await admin.query(`SELECT count(*)::int AS n FROM message_templates WHERE organization_id = $1 AND deleted_at IS NULL`, [ORG_B])).rows[0].n]).toEqual([10, 5]);
  });

  it('la base impide una plantilla «enviable» que no esté aprobada, repetir nombre e idioma en una conexión, nombres inválidos, y a app_rw borrar', async () => {
    await sync(T.alice, channelA);
    const row = (await admin.query(`SELECT id FROM message_templates WHERE name = 'bienvenida' AND language = 'es'`)).rows[0].id as string;
    await expect(admin.query(`UPDATE message_templates SET status = 'pending' WHERE id = $1`, [row])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE message_templates SET unsupported_reason = 'x' WHERE id = $1`, [row])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE message_templates SET name = 'Mal Nombre' WHERE id = $1`, [row])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE message_templates SET language = 'es' WHERE name = 'bienvenida' AND language = 'en_US'`)).rejects.toMatchObject({ code: '23505' });
    const rw = new Client({ connectionString: info.rwUrl });
    await rw.connect();
    try {
      await rw.query('BEGIN');
      await rw.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      await expect(rw.query('DELETE FROM message_templates')).rejects.toMatchObject({ code: '42501' });
      await rw.query('ROLLBACK');
    } finally {
      await rw.end();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('selector de la conversación', () => {
  it('muestra las plantillas de la conexión de la conversación y sincroniza solo si nunca se hizo o lo último tiene más de 10 minutos', async () => {
    const conv = await mkConv();
    const first = await ok<TplList>(await convTemplates(T.carol, conv));
    expect(first.items).toHaveLength(10);
    expect(first.items[0]!.sendable).toBe(true);
    expect(fake().listed).toHaveLength(1); // nunca se había sincronizado
    await ok(await convTemplates(T.carol, conv));
    expect(fake().listed).toHaveLength(1); // reciente: no vuelve a consultar
    await admin.query(`UPDATE whatsapp_accounts SET templates_synced_at = now() - interval '11 minutes' WHERE channel_account_id = $1`, [channelA]);
    await ok(await convTemplates(T.carol, conv));
    expect(fake().listed).toHaveLength(2);
  });

  it('si Meta falla al refrescar, se muestra lo que ya hay con el aviso; no es un error de la petición', async () => {
    await sync(T.alice, channelA);
    await admin.query(`UPDATE whatsapp_accounts SET templates_synced_at = now() - interval '1 hour' WHERE channel_account_id = $1`, [channelA]);
    const f = fake();
    f.listTemplates = () => Promise.reject(new WhatsAppProviderError('unavailable', 'x'));
    const conv = await mkConv();
    const l = await ok<TplList>(await convTemplates(T.carol, conv));
    expect(l.items).toHaveLength(10);
    expect(l.sync_error).toBe('Meta no respondió');
  });

  it('solo quien puede responder: no la ve quien no ve la conversación (404), ni el colaborador de solo ver (403), ni sirve en una finalizada (409)', async () => {
    const conv = await mkConv();
    expect((await convTemplates(T.eve, conv)).status).toBe(404);
    await ok(await call('POST', `/conversations/${conv}/share`, T.carol, { user_id: IDS.eve, permission: 'view' }));
    expect((await convTemplates(T.eve, conv)).status).toBe(403);
    const closed = await mkConv({ status: 'closed' });
    const r = await convTemplates(T.carol, closed);
    expect([r.status, await code(r)]).toEqual([409, 'CONVERSATION_CLOSED']);
    const free = await mkConv({ owner: null });
    expect((await convTemplates(T.alice, free)).status).toBe(409);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('enviar una plantilla', () => {
  const prep = async (): Promise<{ conv: string; list: TplList }> => {
    await sync(T.alice, channelA);
    return { conv: await mkConv(), list: await catalog(channelA) };
  };

  it('dentro de la ventana: sale por el proveedor con las variables, queda como mensaje humano de la plantilla con el texto armado y sus botones, detiene el SLA y deja la conversación «esperando al cliente»', async () => {
    const { conv, list } = await prep();
    await admin.query(`INSERT INTO response_timers(id, organization_id, conversation_id, kind, owner_id, started_at, due_at) VALUES (gen_random_uuid(), $1, $2, 'first', $3, now() - interval '5 minutes', now() + interval '10 minutes')`, [ORG_A, conv, IDS.carol]);
    const tpl = byName(list, 'recordatorio_cita');
    const m = await ok<Msg>(await sendTpl(T.carol, conv, { template_id: tpl.id, params: { 'body:1': '  Ana  ', 'body:2': 'viernes 24', 'body:3': '10:00' } }), 201);
    expect(m).toMatchObject({ kind: 'template', direction: 'out', sender_type: 'human', status: 'sent', error: null, extra: null, is_note: false, author: { id: IDS.carol } });
    expect(m.text).toBe('Hola Ana, te recordamos tu cita el viernes 24 a las 10:00.\n\nResponde para confirmar');
    expect(m.template).toEqual({ name: 'recordatorio_cita', language: 'es', category: 'utility', buttons: [{ type: 'quick_reply', text: 'Confirmar', url: null, phone: null }, { type: 'quick_reply', text: 'Reprogramar', url: null, phone: null }] });
    // lo que viajó al proveedor
    expect(fake().outbox).toHaveLength(1);
    const peer = (await admin.query('SELECT peer_id FROM conversations WHERE id = $1', [conv])).rows[0].peer_id as string;
    expect(fake().outbox[0]).toMatchObject({ to: peer, text: '[plantilla] recordatorio_cita', template: { name: 'recordatorio_cita', language: 'es', components: [{ type: 'body', subType: null, index: null, parameters: [{ name: null, text: 'Ana' }, { name: null, text: 'viernes 24' }, { name: null, text: '10:00' }] }] } });
    // la conversación y el SLA
    expect(await convRow(conv)).toMatchObject({ status: 'waiting' });
    expect((await admin.query(`SELECT stop_reason FROM response_timers WHERE conversation_id = $1`, [conv])).rows).toEqual([{ stop_reason: 'human_reply' }]);
    // el hilo lo devuelve igual y sin los datos de envío
    const thread = (await ok<{ items: Msg[] }>(await call('GET', `/conversations/${conv}/messages`, T.carol))).items;
    expect(thread.at(-1)).toMatchObject({ kind: 'template', template: { name: 'recordatorio_cita' }, extra: null });
    expect(JSON.stringify(thread)).not.toContain('"send"');
  });

  it('fuera de las 24 h: el texto libre es 409 WINDOW_CLOSED y la plantilla sí sale; también cuando el cliente nunca escribió', async () => {
    await sync(T.alice, channelA);
    const tpl = byName(await catalog(channelA), 'bienvenida');
    for (const lastInbound of [ago(30 * HOUR), null]) {
      const conv = await mkConv({ lastInbound });
      const text = await call('POST', `/conversations/${conv}/messages`, T.carol, { text: 'hola' });
      expect([text.status, await code(text)]).toEqual([409, 'WINDOW_CLOSED']);
      const m = await ok<Msg>(await sendTpl(T.carol, conv, { template_id: tpl.id, params: {} }), 201);
      expect(m).toMatchObject({ kind: 'template', status: 'sent' });
      expect(fake().outbox.at(-1)).toMatchObject({ template: { name: 'bienvenida', components: [] } });
    }
  });

  it('encabezado de texto, cuerpo y botón de URL con variable: tres componentes; con variables con nombre, cada una con su nombre', async () => {
    const { conv, list } = await prep();
    const promo = byName(list, 'promo_corte');
    const m = await ok<Msg>(await sendTpl(T.carol, conv, { template_id: promo.id, params: { 'header:1': 'Ana', 'body:1': 'CORTE20', 'button:0:1': 'ana-24' } }), 201);
    expect(m.text).toBe('Promo para Ana\n\nEste mes tu corte tiene 20% de descuento. Reserva con el código CORTE20.');
    expect(m.template!.buttons).toEqual([{ type: 'url', text: 'Reservar', url: 'https://barberia.example/reservar/ana-24', phone: null }, { type: 'phone', text: 'Llamar', url: null, phone: '+593984217730' }]);
    expect(fake().outbox.at(-1)!.template!.components.map((c) => [c.type, c.subType, c.index, c.parameters.map((p) => p.text)])).toEqual([['header', null, null, ['Ana']], ['body', null, null, ['CORTE20']], ['button', 'url', 0, ['ana-24']]]);
    await ok<Msg>(await sendTpl(T.carol, conv, { template_id: byName(list, 'seguimiento_nombrado').id, params: { 'body:nombre': 'Ana', 'body:servicio': 'el corte' } }), 201);
    expect(fake().outbox.at(-1)!.template!.components[0]!.parameters).toEqual([{ name: 'nombre', text: 'Ana' }, { name: 'servicio', text: 'el corte' }]);
  });

  it('valida las variables con el campo que falla (400): faltan, sobran, vacías, con saltos de línea o 4 espacios; y no guarda nada', async () => {
    const { conv, list } = await prep();
    const id = byName(list, 'recordatorio_cita').id;
    const bad = async (params: Record<string, string>) => {
      const r = await sendTpl(T.carol, conv, { template_id: id, params });
      expect(r.status, JSON.stringify(params)).toBe(400);
      return (await json<{ error: { details: Array<{ path: string; message: string }> } }>(r)).error.details.map((d) => [d.path, d.message]);
    };
    expect(await bad({})).toEqual([['params.body:1', 'Falta este dato'], ['params.body:2', 'Falta este dato'], ['params.body:3', 'Falta este dato']]);
    expect(await bad({ 'body:1': 'Ana', 'body:2': 'viernes', 'body:3': '10:00', 'body:4': 'x' })).toEqual([['params.body:4', 'La plantilla no tiene esta variable']]);
    expect(await bad({ 'body:1': 'Ana', 'body:2': 'a\nb', 'body:3': '' })).toEqual([['params.body:2', 'No puede tener saltos de línea ni tabulaciones'], ['params.body:3', 'Escribe un valor']]);
    expect(await bad({ 'body:1': 'a    b', 'body:2': 'x'.repeat(1025), 'body:3': 'ok' })).toEqual([['params.body:1', 'No puede tener más de 3 espacios seguidos'], ['params.body:2', 'Usa como máximo 1024 caracteres']]);
    for (const b of [{ params: {} }, { template_id: 'no-es-uuid', params: {} }, { template_id: id, params: { 'body:1': 5 } }, { template_id: id, params: {}, otro: 1 }]) expect((await sendTpl(T.carol, conv, b)).status, JSON.stringify(b)).toBe(400);
    expect(await msgs(conv)).toEqual([]);
    expect(fake().outbox).toEqual([]);
  });

  it('una plantilla que no se puede enviar es 409 con su motivo; una que no existe, borrada o de otra conexión es 404', async () => {
    const { conv, list } = await prep();
    const cases: Array<[string, string]> = [['catalogo_imagen', 'Lleva una imagen en el encabezado: se podrá usar cuando estén los adjuntos'], ['codigo_acceso', 'Es de autenticación (código de un solo uso): no se envía desde el Inbox'], ['en_revision', 'Meta todavía la está revisando'], ['pausada_calidad', 'Meta la pausó (suele ser por baja calidad)']];
    for (const [name, reason] of cases) {
      const r = await sendTpl(T.carol, conv, { template_id: byName(list, name).id, params: {} });
      expect([r.status, await code(r)], name).toEqual([409, 'TEMPLATE_NOT_AVAILABLE']);
      expect((await json<{ error: { message: string } }>(await sendTpl(T.carol, conv, { template_id: byName(list, name).id, params: {} }))).error.message).toBe(reason);
    }
    expect((await sendTpl(T.carol, conv, { template_id: NOBODY, params: {} })).status).toBe(404);
    // borrada en Meta
    fake().templates = fake().templates.filter((t) => t.name !== 'bienvenida' || t.language !== 'es');
    await sync(T.alice, channelA);
    expect((await sendTpl(T.carol, conv, { template_id: byName(list, 'bienvenida').id, params: {} })).status).toBe(404);
    // de otra conexión de la misma empresa
    const other = await connect(T.alice, '1090123456790', 'Soporte A');
    await sync(T.alice, other);
    const foreign = byName(await catalog(other), 'recordatorio_cita');
    expect((await sendTpl(T.carol, conv, { template_id: foreign.id, params: { 'body:1': 'a', 'body:2': 'b', 'body:3': 'c' } })).status).toBe(404);
    expect(fake().outbox).toEqual([]);
  });

  it('quién puede enviar: su dueño o quien ve todo; un colaborador con permiso de responder solo cuando el dueño ya aceptó; no el de solo ver, ni en una sin asignar', async () => {
    const { conv, list } = await prep();
    const id = byName(list, 'bienvenida').id;
    const send = (token: string, c = conv) => sendTpl(token, c, { template_id: id, params: {} });
    expect((await send(T.alice)).status).toBe(201); // administrador que no es el dueño: ve todo y puede responder
    expect((await send(T.eve)).status).toBe(404); // no la ve
    await ok(await call('POST', `/conversations/${conv}/share`, T.carol, { user_id: IDS.eve, permission: 'view' }));
    expect((await send(T.eve)).status).toBe(403);
    await ok(await call('POST', `/conversations/${conv}/share`, T.carol, { user_id: IDS.eve, permission: 'reply' }));
    expect((await send(T.eve)).status).toBe(201);
    const pending = await mkConv({ status: 'pending' });
    await ok(await call('POST', `/conversations/${pending}/share`, T.carol, { user_id: IDS.eve, permission: 'reply' }));
    const early = await send(T.eve, pending);
    expect([early.status, await code(early)]).toEqual([409, 'CONVERSATION_NOT_ACCEPTED']);
    expect((await send(T.carol, pending)).status).toBe(201); // el dueño, aunque no haya aceptado: equivale a aceptar
    expect(await convRow(pending)).toMatchObject({ status: 'waiting' });
    const free = await mkConv({ owner: null });
    expect((await send(T.alice, free)).status).toBe(409);
    const closed = await mkConv({ status: 'closed' });
    const r = await send(T.carol, closed);
    expect([r.status, await code(r)]).toEqual([409, 'CONVERSATION_CLOSED']);
  });

  it('si Meta la rechaza el mensaje queda «fallido» con una explicación y sin reintentos: plantilla borrada o pausada, datos que ya no coinciden o rechazo; y reintentar funciona fuera de la ventana', async () => {
    const { conv, list } = await prep();
    await admin.query(`UPDATE conversations SET last_inbound_at = now() - interval '30 hours' WHERE id = $1`, [conv]);
    const cita = byName(list, 'recordatorio_cita');
    const params = { 'body:1': 'Ana', 'body:2': 'viernes', 'body:3': '10:00' };
    // la plantilla cambió en Meta entre la sincronización y el envío
    const f = fake();
    f.templates = f.templates.filter((t) => t.name !== 'recordatorio_cita');
    let m = await ok<Msg>(await sendTpl(T.carol, conv, { template_id: cita.id, params }), 201);
    expect(m).toMatchObject({ status: 'failed', error: 'La plantilla ya no está disponible en Meta (pausada, deshabilitada o borrada): sincroniza las plantillas y elige otra' });
    f.templates = [...FAKE_TEMPLATES].map((t) => (t.name === 'recordatorio_cita' ? { ...t, body: { text: 'Hola {{1}}, {{2}}, {{3}} y {{4}}', examples: {} } } : t));
    m = await ok<Msg>(await sendTpl(T.carol, conv, { template_id: cita.id, params }), 201);
    expect(m).toMatchObject({ status: 'failed', error: 'Meta no aceptó los datos de la plantilla: revisa las variables e inténtalo de nuevo' });
    f.templates = [...FAKE_TEMPLATES];
    m = await ok<Msg>(await sendTpl(T.carol, conv, { template_id: cita.id, params: { ...params, 'body:1': '[fallar:rechazo] Ana' } }), 201);
    expect(m).toMatchObject({ status: 'failed', error: 'WhatsApp rechazó el mensaje' });
    expect(await dispatch()).toBe(0); // los rechazos permanentes no se reintentan solos
    // reintentar: vuelve a ponerlo en cola y, con la plantilla de nuevo bien, sale (fuera de las 24 h, porque es una plantilla)
    f.templates = [...FAKE_TEMPLATES];
    const failedId = (await ok<{ items: Msg[] }>(await call('GET', `/conversations/${conv}/messages`, T.carol))).items.find((x) => x.status === 'failed' && x.error!.startsWith('La plantilla ya no'))!.id;
    const retried = await ok<Msg>(await call('POST', `/messages/${failedId}/retry`, T.carol), 200);
    expect(retried).toMatchObject({ status: 'sent', kind: 'template' });
    expect(f.outbox.at(-1)).toMatchObject({ template: { name: 'recordatorio_cita' } });
  });

  it('una caída pasajera del proveedor deja el mensaje en cola con espera creciente y la tarea de envío lo reintenta', async () => {
    const { conv, list } = await prep();
    const cita = byName(list, 'recordatorio_cita');
    const m = await ok<Msg>(await sendTpl(T.carol, conv, { template_id: cita.id, params: { 'body:1': '[fallar:caida] Ana', 'body:2': 'viernes', 'body:3': '10:00' } }), 201);
    expect(m.status).toBe('queued');
    const row = (await admin.query(`SELECT attempts, next_attempt_at FROM messages WHERE id = $1`, [m.id])).rows[0] as { attempts: number; next_attempt_at: Date };
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect(fake().outbox).toEqual([]);
  });

  it('A↔B: B no puede enviar una plantilla de A ni en una conversación de A (404)', async () => {
    const { conv, list } = await prep();
    expect((await sendTpl(T.bob, conv, { template_id: byName(list, 'bienvenida').id, params: {} })).status).toBe(404);
    expect(await msgs(conv)).toEqual([]);
  });
});
