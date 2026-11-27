// V21 · 21.3 — Archivos de la biblioteca adjuntos en «Escribir mensaje» de las automatizaciones (ADR-75 #6).
// Rutas que toca (cubiertas con sus pruebas de aislamiento en library.test.ts y automations.test.ts):
//   GET /v1/library/assets/:id/usage
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { AutomationsJob, AutomationsModule } from '../../src/modules/automations';
import { ContactsModule } from '../../src/modules/contacts';
import { ConversationsService } from '../../src/modules/conversations';
import { CustomFieldsModule } from '../../src/modules/custom-fields';
import { InboxModule } from '../../src/modules/inbox';
import { LibraryModule } from '../../src/modules/library';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { PipelinesModule } from '../../src/modules/pipelines';
import { QueuesModule } from '../../src/modules/queues';
import { TagsModule } from '../../src/modules/tags';
import { TemplatesModule } from '../../src/modules/templates';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({
  imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, CustomFieldsModule, PipelinesModule, OpportunitiesModule, QueuesModule, TagsModule, ChannelsModule, TemplatesModule, InboxModule, LibraryModule, AutomationsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })],
})
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 5)]);

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'bob', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE automation_settings, automation_run_steps, automation_runs, automations, message_templates, response_timers, message_attachments, messages, conversation_participants, conversations, webhook_events, whatsapp_accounts, channel_routes, channel_accounts, tasks, stage_history, opportunities, pipeline_stages, pipelines, contact_tags, tags, custom_field_values, custom_field_definitions, contact_phones, contacts, queue_members, queue_distribution_state, queues, media_assets, media_folders, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.bob, ORG_B, 'client_admin']] as const) {
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
async function uploadAsset(token: string, bytes: Buffer, mime: string, filename: string): Promise<{ id: string; name: string }> {
  const r = await fetch(`${base}/library/assets`, { method: 'POST', headers: { 'content-type': mime, 'x-filename': encodeURIComponent(filename), authorization: `Bearer ${token}` }, body: bytes });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  return json<{ id: string; name: string }>(r);
}

interface Rule { id: string; status: string; actions: Array<Record<string, unknown>> }
interface Run { status: string; steps: Array<{ position: number; action: string; outcome: string; detail: string | null }> }
const body = (name: string, trigger: Record<string, unknown>, actions: unknown[]) => ({ name, trigger, conditions: [], actions });
const mk = async (token: string, b: unknown): Promise<Rule> => {
  const r = await call('POST', '/automations', token, b);
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  return json<Rule>(r);
};
const activate = (token: string, id: string) => call('POST', `/automations/${id}/activate`, token);
const runsOf = async (token: string, id: string): Promise<Run[]> => (await json<{ items: Run[] }>(await call('GET', `/automations/${id}/runs?limit=100`, token))).items;
async function drain(): Promise<void> {
  const job = app.get(AutomationsJob, { strict: false });
  for (let i = 0; i < 15; i += 1) if ((await job.run(new Date())) === 0) break;
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'AI_PROVIDER', 'HTTP_OUT_PROVIDER', 'CAPI_PROVIDER', 'WHATSAPP_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'REQUIRE_VIRUS_SCAN']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: process.env['TEST_LOG'] ?? 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AI_PROVIDER: 'fake', HTTP_OUT_PROVIDER: 'fake', CAPI_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: randomBytes(32).toString('base64') });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => {
  await app.close();
  await admin.end();
  process.env = saved;
});
beforeEach(async () => {
  await seed();
  app.get(OrgDirectoryService).invalidate();
  T = { alice: await login('alice@a.test'), bob: await login('bob@b.test') };
});

async function channelAndInbound(from: string, name: string): Promise<{ ch: string }> {
  const ch = (await json<{ id: string }>(await call('POST', '/channels', T.alice, { name: 'Ventas', waba_id: '1234567890123', phone_number_id: '1090123456789', access_token: FAKE_WHATSAPP_TOKEN }))).id;
  await inbound(ch, 'wamid.1', from, name);
  return { ch };
}
async function inbound(ch: string, id: string, from: string, name: string): Promise<void> {
  const conversations = app.get(ConversationsService, { strict: false });
  const db = app.get(Database, { strict: false });
  await TenantContext.run({ organizationId: ORG_A }, () =>
    db.withTenant((tx) => conversations.ingestInbound(tx, ch, { externalId: id, from, fromRaw: from.slice(1), profileName: name, kind: 'text', text: 'Hola', media: null, extra: {}, sentAt: new Date() }, { now: new Date(), timeZone: 'UTC', assignable: new Set<string>() })),
  );
}

describe('automatizaciones con un archivo de la biblioteca', () => {
  it('la regla envía el archivo como adjunto PROPIO, con el texto de pie y sin tocar la biblioteca', async () => {
    const asset = await uploadAsset(T.alice, PNG, 'image/png', 'catalogo.png');
    const { ch } = await (async () => {
      const chId = (await json<{ id: string }>(await call('POST', '/channels', T.alice, { name: 'Ventas', waba_id: '1234567890123', phone_number_id: '1090123456789', access_token: FAKE_WHATSAPP_TOKEN }))).id;
      return { ch: chId };
    })();
    const rule = await mk(T.alice, body('Catálogo', { type: 'message_received', filter: { channel_id: ch } }, [{ type: 'send_text', text: 'Hola {{primer_nombre}}, este es el catálogo', attachment: { asset_id: asset.id } }]));
    expect((await activate(T.alice, rule.id)).status).toBe(200);
    await inbound(ch, 'wamid.1', '+593984217730', 'Marta Lema');
    await drain();
    const msgs = (await admin.query(`SELECT id, sender_type, kind, body, status FROM messages WHERE direction = 'out'`)).rows;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ sender_type: 'automation', kind: 'image', body: 'Hola Marta, este es el catálogo', status: 'queued' });
    const att = (await admin.query(`SELECT message_id, direction, state, storage_key, kind FROM message_attachments`)).rows;
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ message_id: msgs[0].id, direction: 'out', state: 'ready', kind: 'image' });
    expect(String(att[0].storage_key)).toContain(`org/${ORG_A}/attachments/`); // copia propia, no la clave de la biblioteca
    expect(String(att[0].storage_key)).not.toContain('/library/');
    expect((await admin.query(`SELECT state FROM media_assets WHERE id = $1`, [asset.id])).rows[0].state).toBe('ready');
    expect((await runsOf(T.alice, rule.id))[0]).toMatchObject({ status: 'done', steps: [{ action: 'send_text', outcome: 'done' }] });
  });

  it('si el archivo se archiva después, el paso FALLA a la vista y no se manda nada a medias', async () => {
    const asset = await uploadAsset(T.alice, PNG, 'image/png', 'oferta.png');
    const { ch } = await channelAndInbound('+593984217731', 'Otra Cliente');
    const rule = await mk(T.alice, body('Oferta', { type: 'message_received', filter: { channel_id: ch } }, [{ type: 'send_text', text: 'Oferta', attachment: { asset_id: asset.id } }]));
    expect((await activate(T.alice, rule.id)).status).toBe(200);
    expect((await call('POST', `/library/assets/${asset.id}/archive`, T.alice)).status).toBe(200);
    await inbound(ch, 'wamid.2', '+593984217731', 'Otra Cliente');
    await drain();
    expect((await admin.query(`SELECT count(*)::int AS n FROM messages WHERE direction = 'out'`)).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM message_attachments`)).rows[0].n).toBe(0);
    const step = (await runsOf(T.alice, rule.id))[0]!.steps[0]!;
    expect(step).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('archivó') });
  });

  it('guardar o activar una regla con un archivo archivado, de otra empresa o inexistente se rechaza; pide texto o archivo', async () => {
    const mine = await uploadAsset(T.alice, PNG, 'image/png', 'a.png');
    const theirs = await uploadAsset(T.bob, PNG, 'image/png', 'b.png');
    const archived = await uploadAsset(T.alice, PNG, 'image/png', 'c.png');
    await call('POST', `/library/assets/${archived.id}/archive`, T.alice);
    const trigger = { type: 'contact_created', filter: {} };
    for (const id of [archived.id, theirs.id, '00000000-0000-4000-8000-00000000dead']) {
      expect((await call('POST', '/automations', T.alice, body(`Con ${id.slice(-4)}`, trigger, [{ type: 'send_text', attachment: { asset_id: id } }]))).status, id).toBe(400);
    }
    // si el archivo se archiva DESPUÉS de guardar la regla, activarla también se rechaza
    const later = await uploadAsset(T.alice, PNG, 'image/png', 'd.png');
    const draft = await mk(T.alice, body('Se archivará', trigger, [{ type: 'send_text', attachment: { asset_id: later.id } }]));
    await call('POST', `/library/assets/${later.id}/archive`, T.alice);
    expect((await activate(T.alice, draft.id)).status).toBe(400);
    const ok = await mk(T.alice, body('Solo archivo', trigger, [{ type: 'send_text', attachment: { asset_id: mine.id } }]));
    expect((await activate(T.alice, ok.id)).status).toBe(200);
    // sin texto ni archivo no hay mensaje
    expect((await call('POST', '/automations', T.alice, body('Vacía', trigger, [{ type: 'send_text' }]))).status).toBe(400);
  });

  it('la prueba en seco dice qué archivo enviaría y falla si ya no está disponible', async () => {
    const asset = await uploadAsset(T.alice, PNG, 'image/png', 'lista.png');
    const { ch } = await channelAndInbound('+593984217732', 'Marta Lema');
    const rule = await mk(T.alice, body('Prueba', { type: 'contact_created', filter: {} }, [{ type: 'send_text', text: 'Hola', attachment: { asset_id: asset.id } }]));
    const contact = (await admin.query(`SELECT id FROM contacts LIMIT 1`)).rows[0].id as string;
    expect(ch).toBeTruthy();
    const dry = await json<{ actions: Array<{ would: string; detail: string }> }>(await call('POST', `/automations/${rule.id}/test`, T.alice, { contact_id: contact }));
    expect(dry.actions[0]).toMatchObject({ would: 'do', detail: expect.stringContaining('lista.png') });
    await call('POST', `/library/assets/${asset.id}/archive`, T.alice);
    const after = await json<{ actions: Array<{ would: string }> }>(await call('POST', `/automations/${rule.id}/test`, T.alice, { contact_id: contact }));
    expect(after.actions[0]!.would).toBe('fail');
  });

  it('GET /library/assets/:id/usage lista las automatizaciones que lo usan y otra empresa no lo ve', async () => {
    const asset = await uploadAsset(T.alice, PNG, 'image/png', 'uso.png');
    const rule = await mk(T.alice, body('Usa el archivo', { type: 'contact_created', filter: {} }, [{ type: 'send_text', attachment: { asset_id: asset.id } }]));
    const free = await uploadAsset(T.alice, PNG, 'image/png', 'libre.png');
    const used = await json<{ automations: Array<{ id: string; name: string }> }>(await call('GET', `/library/assets/${asset.id}/usage`, T.alice));
    expect(used.automations).toEqual([{ id: rule.id, name: 'Usa el archivo', status: 'draft' }]);
    expect((await json<{ automations: unknown[] }>(await call('GET', `/library/assets/${free.id}/usage`, T.alice))).automations).toEqual([]);
    expect((await call('GET', `/library/assets/${asset.id}/usage`, T.bob)).status).toBe(404); // aislamiento A↔B
    expect((await call('GET', `/library/assets/${asset.id}/usage`)).status).toBe(401);
  });
});
