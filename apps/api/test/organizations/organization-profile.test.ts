// V25 · 25.1 — Perfil de la empresa. Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/organization/profile
//   PATCH /v1/organization/profile
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AttributionModule } from '../../src/modules/attribution';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationProfileModule } from '../../src/modules/organization-profile';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QuickRepliesModule } from '../../src/modules/quick-replies';
import { QueuesModule } from '../../src/modules/queues';
import { SalesModule } from '../../src/modules/sales';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, ChannelsModule, QueuesModule, OpportunitiesModule, AttributionModule.register(), InboxModule, SalesModule, QuickRepliesModule, OrganizationProfileModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A, dueña de las conversaciones
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1', // Súper Admin
  agencyOrg: '00000000-0000-4000-8000-0000000000a9',
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob' | 'dave' | 'root', string>;
let sales = '';
let productId = '';
let channelA = '';
const saved = { ...process.env };

async function start(): Promise<void> {
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY, WHATSAPP_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
}

async function seed(): Promise<void> {
  await admin.query('TRUNCATE organization_profiles, quick_replies, notifications, sale_change_requests, sale_payments, sale_status_history, sales, meta_events, response_timers, messages, conversation_participants, conversations, stage_history, opportunities, pipeline_stages, pipelines, contact_tags, tags, contact_phones, contacts, queue_products, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [IDS.agencyOrg, 'agency', 'Agencia Uno']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia.test', 'Dario Agencia'], [IDS.root, 'root@plat.test', 'Rita Root']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
  await admin.query(`UPDATE organizations SET parent_agency_id = $2, agency_access_level = 'admin' WHERE id = $1`, [ORG_A, IDS.agencyOrg]);
  for (const [o, level] of [[IDS.agencyOrg, 'admin'], [ORG_A, 'admin']] as const) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role,access_level) VALUES (gen_random_uuid(),$1,$2,'agency',$3)`, [IDS.dave, o, level]);
}

const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const count = async (sql: string): Promise<number> => (await admin.query(sql)).rows[0].n as number;
let seq = 0;
async function mkConv(o: { owner?: string | null; queue?: string | null; status?: string; deleted?: boolean; org?: string; channel?: string } = {}): Promise<string> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const status = o.deleted ? 'closed' : (o.status ?? (owner ? 'working' : 'unassigned'));
  const phone = `+59398901${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, `Cliente ${seq}`, owner])).rows[0].id as string;
  await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  return (await admin.query(
    `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, queue_id, status, owner_id, assigned_at, last_message_at, unread_count, peer_id, deleted_at, closed_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END, now(), 0, $7, CASE WHEN $8 THEN now() END, CASE WHEN $5 = 'closed' THEN now() END) RETURNING id`,
    [org, contact, o.channel ?? channelA, o.queue ?? null, status, owner, phone.replace('+', ''), o.deleted === true],
  )).rows[0].id as string;
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  await start();
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia.test'), root: await login('root@plat.test') };
  const mkQueue = async (token: string, name: string): Promise<string> => (await json<{ id: string }>(await call('POST', '/queues', token, { name }))).id;
  sales = await mkQueue(T.alice, 'Ventas');
  productId = (await json<{ id: string }>(await call('POST', `/queues/${sales}/products`, T.alice, { name: 'Corte de cabello', kind: 'service', price: 12.5 }))).id;
  const ch = await call('POST', '/channels', T.alice, { name: 'Ventas', waba_id: '1234567890123', phone_number_id: '1090123456789', access_token: FAKE_WHATSAPP_TOKEN });
  expect(ch.status).toBe(201);
  channelA = (await json<{ id: string }>(ch)).id;
});

interface Profile {
  name: string; country: string | null; timezone: string; currency: string; currency_locked: boolean; currency_locked_reason: string | null;
  legal_name: string | null; tax_id: string | null; contact_phone: string | null; contact_email: string | null; website: string | null; address: string | null; city: string | null; description: string | null;
  access: { edit: boolean };
}
const get = async (token: string): Promise<Profile> => {
  const r = await call('GET', '/organization/profile', token);
  expect(r.status, await r.clone().text()).toBe(200);
  return json<Profile>(r);
};
const patch = (token: string, body: unknown) => call('PATCH', '/organization/profile', token, body);
const sell = (token: string, conv: string) => call('POST', '/sales', token, { conversation_id: conv, product_id: productId, amount: 25 }, { 'idempotency-key': `k-${randomUUID()}` });
const audit = () => admin.query(`SELECT organization_id, old_value, new_value, actor_user_id, acting_as FROM audit_logs WHERE entity_type = 'organization.profile' ORDER BY at`).then((r) => r.rows);
const CONTACT = { legal_name: 'Barbería Norte S.A.', tax_id: '0999999999001', contact_phone: '+593987654321', contact_email: 'hola@barberia.test', website: 'https://barberia.test', address: 'Av. Siempre Viva 742', city: 'Guayaquil', description: 'Cortes y barba.\nCon cita.' };

describe('ver y editar el perfil', () => {
  it('sin nada guardado devuelve la identidad y los datos vacíos; guardar cambia solo lo enviado y crea una sola fila', async () => {
    expect(await get(T.alice)).toEqual({ name: 'Barbería Norte', country: null, timezone: 'America/Guayaquil', currency: 'USD', currency_locked: false, currency_locked_reason: null, legal_name: null, tax_id: null, contact_phone: null, contact_email: null, website: null, address: null, city: null, description: null, access: { edit: true } });
    const r = await patch(T.alice, CONTACT);
    expect(r.status).toBe(200);
    expect(await json<Profile>(r)).toMatchObject({ ...CONTACT, name: 'Barbería Norte' });
    expect(await json<Profile>(await patch(T.alice, { city: 'Durán', website: '' }))).toMatchObject({ city: 'Durán', website: null, legal_name: CONTACT.legal_name });
    expect(await count(`SELECT count(*)::int n FROM organization_profiles`)).toBe(1);
  });

  it('el nombre, el país y la zona horaria cambian la empresa y se ven al instante en «quién soy»; repetir no audita', async () => {
    const r = await patch(T.alice, { name: '  Barbería del Sur  ', country: 'ec', timezone: 'America/Bogota' });
    expect(await json<Profile>(r)).toMatchObject({ name: 'Barbería del Sur', country: 'EC', timezone: 'America/Bogota' });
    expect((await json<{ organization: { name: string } }>(await call('GET', '/auth/me', T.carol))).organization.name).toBe('Barbería del Sur');
    expect((await patch(T.alice, { name: 'Barbería del Sur', timezone: 'America/Bogota' })).status).toBe(200);
    expect(await audit()).toHaveLength(1);
  });

  it('la auditoría lleva el nombre antes y después, pero del teléfono, el correo y la dirección solo el nombre del campo', async () => {
    await patch(T.alice, { name: 'Nuevo Nombre', ...CONTACT });
    const [row] = await audit();
    expect(row).toMatchObject({ organization_id: ORG_A, actor_user_id: IDS.alice, acting_as: null, old_value: { name: 'Barbería Norte' }, new_value: { name: 'Nuevo Nombre' } });
    expect((row!.new_value as { fields: string[] }).fields.sort()).toEqual(['address', 'city', 'contact_email', 'contact_phone', 'description', 'legal_name', 'name', 'tax_id', 'website']);
    const text = JSON.stringify(row);
    for (const secret of [CONTACT.contact_phone, CONTACT.contact_email, CONTACT.address]) expect(text).not.toContain(secret);
  });

  it('valida: zona, país, https, teléfono, correo, largos; la moneda y lo desconocido no se aceptan; cuerpo vacío no', async () => {
    const bad = [{ timezone: 'Marte/Base' }, { country: 'ZZ' }, { name: ' a ' }, { website: 'http://inseguro.test' }, { contact_phone: '0987654321' }, { contact_email: 'no-es-correo' }, { legal_name: 'x'.repeat(121) }, { description: 'x'.repeat(501) }, { currency: 'EUR' }, { organization_id: ORG_B, name: 'Robo' }, {}];
    for (const body of bad) expect((await patch(T.alice, body)).status, JSON.stringify(body)).toBe(400);
    expect(await get(T.alice)).toMatchObject({ name: 'Barbería Norte', currency: 'USD' });
    expect(await audit()).toEqual([]);
  });

  it('con una venta registrada la moneda aparece bloqueada con su motivo', async () => {
    const conv = await mkConv({ queue: sales });
    expect((await sell(T.carol, conv)).status).toBe(201);
    expect(await get(T.alice)).toMatchObject({ currency_locked: true, currency_locked_reason: expect.stringContaining('ventas') });
  });

  it('{{empresa}} usa el nombre nuevo en las respuestas rápidas', async () => {
    expect((await call('POST', '/quick-replies', T.alice, { shortcut: 'hola', body: 'Te escribe {{empresa}}', shared: true })).status).toBe(201);
    const conv = await mkConv();
    const text = async () => (await json<{ items: Array<{ text: string }> }>(await call('GET', `/conversations/${conv}/quick-replies`, T.carol))).items[0]!.text;
    expect(await text()).toBe('Te escribe Barbería Norte');
    await patch(T.alice, { name: 'Barbería del Sur' });
    expect(await text()).toBe('Te escribe Barbería del Sur');
  });
});

describe('quién puede', () => {
  it('la asesora lo ve en solo lectura y no puede cambiarlo; sin sesión 401', async () => {
    expect((await get(T.carol)).access).toEqual({ edit: false });
    expect((await patch(T.carol, { name: 'Otro' })).status).toBe(403);
    expect((await call('GET', '/organization/profile')).status).toBe(401);
    expect(await get(T.alice)).toMatchObject({ name: 'Barbería Norte' });
  });

  it('aislamiento A↔B: cada empresa ve y cambia solo lo suyo', async () => {
    await patch(T.alice, CONTACT);
    expect(await get(T.bob)).toMatchObject({ name: 'Estudio Luna', legal_name: null, contact_phone: null });
    expect((await patch(T.bob, { name: 'Estudio Sol', city: 'Quito' })).status).toBe(200);
    expect(await get(T.alice)).toMatchObject({ name: 'Barbería Norte', city: 'Guayaquil' });
    expect((await admin.query(`SELECT organization_id, city FROM organization_profiles ORDER BY city`)).rows).toEqual([{ organization_id: ORG_A, city: 'Guayaquil' }, { organization_id: ORG_B, city: 'Quito' }]);
  });

  it('la agencia «administrador» edita y queda marcada; en «lectura» y «asesor» no; el Súper Admin en soporte sí', async () => {
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    expect((await patch(T.dave, { city: 'Samborondón' })).status).toBe(200);
    for (const level of ['read', 'advisor']) {
      await admin.query(`UPDATE organization_members SET access_level = $3 WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A, level]);
      expect((await get(T.dave)).access, level).toEqual({ edit: false });
      expect((await patch(T.dave, { city: 'Nope' })).status, level).toBe(403);
    }
    expect((await call('POST', '/context/switch', T.root, { target: ORG_A })).status).toBe(200);
    expect((await patch(T.root, { name: 'Cambiado por soporte' })).status).toBe(200);
    expect((await audit()).map((r) => [r.actor_user_id, r.acting_as])).toEqual([[IDS.dave, 'agency'], [IDS.root, 'super_admin']]);
  });

  it('«Ver como» asesor deja mirar y no cambiar', async () => {
    expect((await call('POST', '/context/view-as', T.alice, { role: 'advisor' })).status).toBe(200);
    expect((await get(T.alice)).access).toEqual({ edit: false });
    expect((await patch(T.alice, { name: 'No' })).status).toBe(403);
  });

  it('con la prueba vencida la cuenta del cliente sigue en pausa; la agencia solo puede mirar', async () => {
    await admin.query(`INSERT INTO trials(id, organization_id, owner_user_id, started_at, ends_at, status, expired_at) VALUES (gen_random_uuid(),$1,$2, now() - interval '12 days', now() - interval '5 days', 'expired', now() - interval '5 days')`, [ORG_A, IDS.alice]);
    expect((await call('GET', '/organization/profile', T.alice)).status).toBe(403);
    expect((await patch(T.alice, { name: 'No' })).status).toBe(403);
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    expect((await get(T.dave)).access).toEqual({ edit: false });
    expect((await patch(T.dave, { name: 'No' })).status).toBe(403);
  });
});
