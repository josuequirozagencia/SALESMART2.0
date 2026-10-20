// M5.6b — Respuestas rápidas con variables (ADR-50). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/quick-replies
//   POST /v1/quick-replies
//   PATCH /v1/quick-replies/:id
//   DELETE /v1/quick-replies/:id
//   GET /v1/conversations/:id/quick-replies
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
import { ChannelsModule, FAKE_WHATSAPP_TOKEN } from '../../src/modules/channels';
import { ContactsModule } from '../../src/modules/contacts';
import { InboxModule } from '../../src/modules/inbox';
import { OpportunitiesModule } from '../../src/modules/opportunities';
import { OrganizationsModule } from '../../src/modules/organizations';
import { QueuesModule } from '../../src/modules/queues';
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
  await admin.query('TRUNCATE quick_replies, custom_field_values, custom_field_definitions, response_timers, messages, conversation_participants, conversations, webhook_events, queue_distribution_state, queue_members, whatsapp_accounts, channel_accounts, queues, channel_routes, contact_tags, contact_phones, contacts, tags, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
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

interface QR { id: string; shortcut: string; body: string; shared: boolean; mine: boolean; can_edit: boolean; variables: string[]; updated_at: string }
interface QRResolved extends QR { text: string; missing: string[] }
interface QRList { items: QR[]; access: { share: boolean }; built_in_variables: Array<{ key: string; label: string }> }

const list = async (token: string): Promise<QRList> => ok<QRList>(await call('GET', '/quick-replies', token));
const create = (token: string, body: unknown) => call('POST', '/quick-replies', token, body);
const mk = async (token: string, shortcut: string, body: string, shared = false): Promise<QR> => ok<QR>(await create(token, { shortcut, body, shared }), 201);
const forConv = async (token: string, conv: string): Promise<QRResolved[]> => (await ok<{ items: QRResolved[] }>(await call('GET', `/conversations/${conv}/quick-replies`, token))).items;
const pick = (items: QRResolved[], shortcut: string, shared?: boolean): QRResolved => items.find((q) => q.shortcut === shortcut && (shared === undefined || q.shared === shared))!;

let seq = 0;
async function mkConv(o: { owner?: string | null; name?: string | null; org?: string; noPhone?: boolean } = {}): Promise<{ conv: string; contact: string }> {
  seq += 1;
  const org = o.org ?? ORG_A;
  const owner = o.owner === undefined ? IDS.carol : o.owner;
  const phone = `+59398700${String(seq).padStart(4, '0')}`;
  const contact = (await admin.query(`INSERT INTO contacts(id, organization_id, name, owner_id) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [org, o.name === undefined ? `Marcela Paredes ${seq}` : o.name, owner])).rows[0].id as string;
  if (!o.noPhone) await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, contact, phone]);
  const conv = (
    await admin.query(
      `INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, owner_id, assigned_at, last_message_at, last_inbound_at, unread_count, peer_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 1, $9) RETURNING id`,
      [org, contact, org === ORG_B ? channelB : channelA, owner ? 'working' : 'unassigned', owner, owner ? new Date() : null, ago(30 * MIN), ago(HOUR), phone.slice(1)],
    )
  ).rows[0].id as string;
  return { conv, contact };
}
const phoneOf = async (contact: string): Promise<string> => (await admin.query(`SELECT e164 FROM contact_phones WHERE contact_id = $1`, [contact])).rows[0].e164 as string;
async function mkField(token: string, name: string, type = 'text'): Promise<{ id: string; key: string }> {
  return ok<{ id: string; key: string }>(await call('POST', '/custom-fields', token, { name, type }), 201);
}
const setField = async (token: string, contact: string, values: Record<string, unknown>) => ok(await call('PATCH', `/contacts/${contact}`, token, { custom_fields: values }));
const audit = async (entity: string, id: string) => (await admin.query(`SELECT field, old_value, new_value FROM audit_logs WHERE entity_type = $1 AND entity_id = $2 ORDER BY at, id`, [entity, id])).rows as Array<{ field: string | null; old_value: unknown; new_value: unknown }>;

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
});

// ═════════════════════════════════════════════════════════════════════════════
describe('permisos y aislamiento', () => {
  it('sin sesión 401; la plataforma 403; el asesor puede crear las suyas pero no compartir (403 QUICK_REPLY_SHARE_NOT_ALLOWED); el administrador sí', async () => {
    const { conv } = await mkConv();
    const routes: Array<[string, string, unknown?]> = [['GET', '/quick-replies'], ['POST', '/quick-replies', { shortcut: 'hola', body: 'Hola' }], ['PATCH', `/quick-replies/${NOBODY}`, { body: 'x' }], ['DELETE', `/quick-replies/${NOBODY}`], ['GET', `/conversations/${conv}/quick-replies`]];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
    }
    const mine = await mk(T.carol, 'hola', 'Hola {{primer_nombre}}');
    expect(mine).toMatchObject({ shared: false, mine: true, can_edit: true });
    const r = await create(T.carol, { shortcut: 'todos', body: 'Para todos', shared: true });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('QUICK_REPLY_SHARE_NOT_ALLOWED');
    // tampoco pasándola de personal a compartida
    const upd = await call('PATCH', `/quick-replies/${mine.id}`, T.carol, { shared: true });
    expect(upd.status).toBe(403);
    expect(await code(upd)).toBe('QUICK_REPLY_SHARE_NOT_ALLOWED');
    expect((await mk(T.alice, 'todos', 'Para todos', true)).shared).toBe(true);
  });

  it('A↔B: nadie ve, cambia ni borra las respuestas de otra empresa (404) ni las resuelve en sus conversaciones; el mismo atajo en dos empresas convive', async () => {
    const a = await mk(T.alice, 'precios', 'Nuestros precios', true);
    const b = await mk(T.bob, 'precios', 'Precios de Luna', true);
    await mk(T.carol, 'hola', 'Hola desde A');
    const convA = await mkConv();
    const convB = await mkConv({ org: ORG_B, owner: IDS.bob });
    expect((await list(T.bob)).items.map((q) => q.body)).toEqual(['Precios de Luna']);
    expect((await list(T.alice)).items.map((q) => q.body)).toEqual(['Nuestros precios']); // la personal de Carolina no es de Alicia
    expect((await call('PATCH', `/quick-replies/${a.id}`, T.bob, { body: 'hackeo' })).status).toBe(404);
    expect((await call('DELETE', `/quick-replies/${a.id}`, T.bob)).status).toBe(404);
    expect((await call('PATCH', `/quick-replies/${b.id}`, T.alice, { body: 'hackeo' })).status).toBe(404);
    expect((await call('GET', `/conversations/${convA.conv}/quick-replies`, T.bob)).status).toBe(404);
    expect((await call('GET', `/conversations/${convB.conv}/quick-replies`, T.alice)).status).toBe(404);
    expect((await forConv(T.bob, convB.conv)).map((q) => q.body)).toEqual(['Precios de Luna']);
    expect((await admin.query(`SELECT body FROM quick_replies WHERE id = $1`, [a.id])).rows[0].body).toBe('Nuestros precios');
  });

  it('las personales son de su dueño: otra persona de la misma empresa (ni el administrador) no las ve, cambia ni borra (404); las compartidas las ven todos y solo el administrador las cambia (403 al asesor)', async () => {
    const mine = await mk(T.carol, 'mia', 'Solo mía');
    const shared = await mk(T.alice, 'equipo', 'Para el equipo', true);
    expect((await list(T.eve)).items.map((q) => q.shortcut)).toEqual(['equipo']);
    expect((await list(T.alice)).items.map((q) => q.shortcut)).toEqual(['equipo']);
    for (const t of [T.eve, T.alice]) {
      expect((await call('PATCH', `/quick-replies/${mine.id}`, t, { body: 'robada' })).status).toBe(404);
      expect((await call('DELETE', `/quick-replies/${mine.id}`, t)).status).toBe(404);
    }
    const carolView = await list(T.carol);
    expect(carolView.items.find((q) => q.shortcut === 'equipo')).toMatchObject({ shared: true, mine: false, can_edit: false });
    expect(carolView.items.find((q) => q.shortcut === 'mia')).toMatchObject({ shared: false, mine: true, can_edit: true });
    expect((await list(T.alice)).items[0]).toMatchObject({ shortcut: 'equipo', can_edit: true });
    const r = await call('PATCH', `/quick-replies/${shared.id}`, T.carol, { body: 'cambiada' });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe('QUICK_REPLY_NOT_YOURS');
    expect((await call('DELETE', `/quick-replies/${shared.id}`, T.carol)).status).toBe(403);
    // otro administrador… el mismo: la compartida la cambia quien administra
    expect((await ok<QR>(await call('PATCH', `/quick-replies/${shared.id}`, T.alice, { body: 'Para todo el equipo' }))).body).toBe('Para todo el equipo');
    // ids que no existen
    expect((await call('PATCH', `/quick-replies/${NOBODY}`, T.alice, { body: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/quick-replies/${NOBODY}`, T.alice)).status).toBe(404);
  });

  it('con la lista se entregan las variables de la casa y si la persona puede compartir', async () => {
    const l = await list(T.carol);
    expect(l.access).toEqual({ share: false });
    expect((await list(T.alice)).access).toEqual({ share: true });
    expect(l.built_in_variables.map((v) => v.key)).toEqual(['primer_nombre', 'nombre', 'telefono', 'mi_nombre', 'empresa']);
    expect(l.built_in_variables.every((v) => v.label.length > 0)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('atajo, texto y límites', () => {
  it('el atajo se guarda limpio (sin «/», en minúsculas) y se rechaza lo que no sirve (400); el texto no puede estar vacío ni pasarse', async () => {
    expect((await mk(T.carol, ' /Saludo-1 ', 'Hola')).shortcut).toBe('saludo-1');
    for (const shortcut of ['', '/', 'con espacio', 'tilde-ñ', 'a'.repeat(33), '-guion', '../x', 'a/b']) {
      const r = await create(T.carol, { shortcut, body: 'Hola' });
      expect(r.status, shortcut).toBe(400);
    }
    expect((await create(T.carol, { shortcut: 'ok', body: '   ' })).status).toBe(400);
    expect((await create(T.carol, { shortcut: 'ok', body: 'x'.repeat(4097) })).status).toBe(400);
    expect((await create(T.carol, { shortcut: 'ok', body: 'Hola\u0000' })).status).toBe(400);
    expect((await create(T.carol, { shortcut: 'ok', body: 'Línea 1\nLínea 2\tcon tabulación' })).status).toBe(201);
    expect((await create(T.carol, { shortcut: 'extra', body: 'Hola', rol: 'admin' })).status).toBe(400); // campos desconocidos
    expect((await call('PATCH', `/quick-replies/${NOBODY}`, T.carol, {})).status).toBe(400);
  });

  it('no se repite el atajo entre las propias (409 QUICK_REPLY_EXISTS) ni entre las compartidas; una personal y una compartida pueden llamarse igual; cada persona tiene las suyas; al borrar se libera', async () => {
    const mine = await mk(T.carol, 'hola', 'Hola 1');
    const r = await create(T.carol, { shortcut: '/HOLA', body: 'Hola 2' });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('QUICK_REPLY_EXISTS');
    await mk(T.eve, 'hola', 'Hola de Eva'); // otra persona
    await mk(T.alice, 'hola', 'Hola de todos', true); // compartida con el mismo atajo que una personal
    expect(await code(await create(T.alice, { shortcut: 'hola', body: 'Otra', shared: true }))).toBe('QUICK_REPLY_EXISTS');
    // cambiar el atajo a uno que ya está
    const other = await mk(T.carol, 'adios', 'Adiós');
    expect(await code(await call('PATCH', `/quick-replies/${other.id}`, T.carol, { shortcut: 'hola' }))).toBe('QUICK_REPLY_EXISTS');
    // la personal pasa a compartida y choca con la compartida que ya existe
    expect(await code(await call('PATCH', `/quick-replies/${mine.id}`, T.alice, { shared: true }))).toBe('NOT_FOUND'); // no es del administrador
    // borrar libera el atajo
    expect((await call('DELETE', `/quick-replies/${mine.id}`, T.carol)).status).toBe(200);
    expect((await mk(T.carol, 'hola', 'Hola de nuevo')).body).toBe('Hola de nuevo');
    expect((await list(T.carol)).items.filter((q) => q.shortcut === 'hola').map((q) => q.shared).sort()).toEqual([false, true]);
  });

  it('hay un máximo de 200 por persona y 200 compartidas (409 QUICK_REPLY_LIMIT); borrar una deja crear otra', async () => {
    await admin.query(`INSERT INTO quick_replies(id, organization_id, owner_id, shortcut, body, shared) SELECT gen_random_uuid(), $1, $2, 'r' || g, 'Texto', false FROM generate_series(1, 200) g`, [ORG_A, IDS.carol]);
    const r = await create(T.carol, { shortcut: 'una-mas', body: 'Texto' });
    expect(r.status).toBe(409);
    expect(await code(r)).toBe('QUICK_REPLY_LIMIT');
    expect((await mk(T.eve, 'una-mas', 'Texto')).shortcut).toBe('una-mas'); // el tope es por persona
    const first = (await admin.query(`SELECT id FROM quick_replies WHERE owner_id = $1 LIMIT 1`, [IDS.carol])).rows[0].id as string;
    expect((await call('DELETE', `/quick-replies/${first}`, T.carol)).status).toBe(200);
    expect((await mk(T.carol, 'una-mas', 'Texto')).shortcut).toBe('una-mas');
    await admin.query(`INSERT INTO quick_replies(id, organization_id, owner_id, shortcut, body, shared) SELECT gen_random_uuid(), $1, $2, 's' || g, 'Texto', true FROM generate_series(1, 200) g`, [ORG_A, IDS.alice]);
    expect(await code(await create(T.alice, { shortcut: 'compartida-extra', body: 'Texto', shared: true }))).toBe('QUICK_REPLY_LIMIT');
  });

  it('cambiar y borrar se auditan (sin guardar nada de más) y el borrado es lógico', async () => {
    const q = await mk(T.carol, 'hola', 'Hola {{primer_nombre}}');
    await ok(await call('PATCH', `/quick-replies/${q.id}`, T.carol, { body: 'Buenas {{primer_nombre}}', shortcut: 'buenas' }));
    await ok(await call('PATCH', `/quick-replies/${q.id}`, T.carol, { body: 'Buenas {{primer_nombre}}' })); // sin cambios: nada que auditar
    await ok(await call('DELETE', `/quick-replies/${q.id}`, T.carol));
    const rows = await audit('quick_reply', q.id);
    expect(rows.map((r) => r.field)).toEqual([null, 'shortcut', 'body', null]);
    const row = (await admin.query(`SELECT deleted_at FROM quick_replies WHERE id = $1`, [q.id])).rows[0];
    expect(row.deleted_at).not.toBeNull();
    expect((await list(T.carol)).items).toEqual([]);
    expect((await call('PATCH', `/quick-replies/${q.id}`, T.carol, { body: 'x' })).status).toBe(404); // borrada
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('variables', () => {
  it('una variable que no existe se rechaza con su nombre (400), al crear y al cambiar; las de la casa y los campos personalizados vigentes se aceptan', async () => {
    const f = await mkField(T.alice, 'Ciudad');
    expect(f.key).toBe('ciudad');
    const bad = await create(T.carol, { shortcut: 'mal', body: 'Hola {{primer_nombre}} {{foo}} {{contact.noexiste}}' });
    expect(bad.status).toBe(400);
    const details = (await json<{ error: { details: Array<{ path: string; code: string; message: string }> } }>(bad)).error.details;
    expect(details.map((d) => d.code)).toEqual(['unknown_variable', 'unknown_variable']);
    expect(details[0]!.path).toBe('body');
    expect(details.map((d) => d.message).join(' ')).toContain('{{foo}}');
    expect(details.map((d) => d.message).join(' ')).toContain('{{contact.noexiste}}');
    const good = await mk(T.carol, 'bien', 'Hola {{primer_nombre}} de {{ contact.ciudad }}, soy {{mi_nombre}} de {{empresa}}. Tu número: {{telefono}} / {{nombre}}');
    expect(good.variables).toEqual(['primer_nombre', 'contact.ciudad', 'mi_nombre', 'empresa', 'telefono', 'nombre']);
    const upd = await call('PATCH', `/quick-replies/${good.id}`, T.carol, { body: 'Hola {{apellido}}' });
    expect(upd.status).toBe(400);
    expect((await list(T.carol)).items[0]!.body).toContain('{{ contact.ciudad }}'); // no cambió
    // el campo de otra empresa no existe para esta
    await mkField(T.bob, 'Zona');
    expect((await create(T.carol, { shortcut: 'zona', body: '{{contact.zona}}' })).status).toBe(400);
  });

  it('un campo archivado después ya no se puede usar en respuestas nuevas, y en las que lo usaban queda sin resolver (se avisa)', async () => {
    const f = await mkField(T.alice, 'Ciudad');
    await mk(T.carol, 'ciudad', 'Te escribo desde {{contact.ciudad}}');
    const { conv, contact } = await mkConv();
    await setField(T.alice, contact, { ciudad: 'Quito' });
    expect(pick(await forConv(T.carol, conv), 'ciudad').text).toBe('Te escribo desde Quito');
    await ok(await call('POST', `/custom-fields/${f.id}/archive`, T.alice));
    const after = pick(await forConv(T.carol, conv), 'ciudad');
    expect(after.text).toBe('Te escribo desde {{contact.ciudad}}');
    expect(after.missing).toEqual(['contact.ciudad']);
    expect((await create(T.carol, { shortcut: 'nueva', body: '{{contact.ciudad}}' })).status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('resolver en una conversación', () => {
  it('resuelve con los datos del contacto de ESA conversación, de quien escribe y de la empresa; lo que falta queda como está y se avisa', async () => {
    expect((await mkField(T.alice, 'Ciudad')).key).toBe('ciudad');
    expect((await mkField(T.alice, 'Cumpleaños', 'date')).key).toBe('cumpleanos');
    expect((await mkField(T.alice, 'Interesado', 'boolean')).key).toBe('interesado');
    const { conv, contact } = await mkConv({ name: 'Marcela Paredes' });
    await setField(T.alice, contact, { ciudad: 'Guayaquil', cumpleanos: '1990-05-17', interesado: true });
    await mk(T.carol, 'hola', 'Hola {{primer_nombre}}, soy {{mi_nombre}} de {{empresa}}');
    await mk(T.carol, 'datos', '{{nombre}} · {{telefono}} · {{contact.ciudad}} · {{contact.cumpleanos}} · {{contact.interesado}}');
    await mk(T.carol, 'falta', 'Hola {{primer_nombre}}: {{contact.cumpleanos}} / {{contact.interesado}}');
    const items = await forConv(T.carol, conv);
    const phone = await phoneOf(contact);
    expect(pick(items, 'hola')).toMatchObject({ text: 'Hola Marcela, soy Carolina Vera de Barbería Norte', missing: [], body: 'Hola {{primer_nombre}}, soy {{mi_nombre}} de {{empresa}}' });
    expect(pick(items, 'datos')).toMatchObject({ text: `Marcela Paredes · ${phone} · Guayaquil · 17/05/1990 · Sí`, missing: [] });
    // otro contacto sin esos datos
    const other = await mkConv({ name: 'Luis Andrade' });
    const miss = pick(await forConv(T.carol, other.conv), 'falta');
    expect(miss.text).toBe('Hola Luis: {{contact.cumpleanos}} / {{contact.interesado}}');
    expect(miss.missing).toEqual(['contact.cumpleanos', 'contact.interesado']);
    // el administrador ve esta conversación, pero la personal de Carolina no es suya
    expect((await forConv(T.alice, conv)).find((q) => q.shortcut === 'hola')).toBeUndefined();
  });

  it('sin teléfono no inventa: la variable queda sin resolver; las compartidas se resuelven con quien las usa', async () => {
    await mk(T.alice, 'presentacion', 'Soy {{mi_nombre}} ({{telefono}}) para {{nombre}}', true);
    const { conv } = await mkConv({ name: 'Luis Andrade', noPhone: true, owner: IDS.eve });
    const q = pick(await forConv(T.eve, conv), 'presentacion');
    expect(q.text).toBe('Soy Eva Mora ({{telefono}}) para Luis Andrade');
    expect(q.missing).toEqual(['telefono']);
    expect(pick(await forConv(T.alice, conv), 'presentacion').text).toBe('Soy Alicia Torres ({{telefono}}) para Luis Andrade');
  });

  it('un valor del contacto que contiene {{…}} no se vuelve a interpretar', async () => {
    await mk(T.carol, 'eco', 'Hola {{nombre}}');
    const { conv } = await mkConv({ name: '{{mi_nombre}} Paredes' });
    expect(pick(await forConv(T.carol, conv), 'eco').text).toBe('Hola {{mi_nombre}} Paredes');
  });

  it('el acceso es el de la conversación: quien no la ve recibe 404; un colaborador que puede responder la usa y ve las compartidas y las suyas, nunca las personales de otro', async () => {
    await mk(T.alice, 'equipo', 'Equipo', true);
    await mk(T.carol, 'mia', 'De Carolina');
    await mk(T.eve, 'deeva', 'De Eva');
    const { conv } = await mkConv(); // de Carolina
    expect((await call('GET', `/conversations/${conv}/quick-replies`, T.eve)).status).toBe(404); // no la ve
    await ok(await call('POST', `/conversations/${conv}/share`, T.carol, { user_id: IDS.eve, permission: 'reply' }));
    expect((await forConv(T.eve, conv)).map((q) => q.shortcut).sort()).toEqual(['deeva', 'equipo']);
    // y las de Eva se resuelven con SU nombre
    await mk(T.eve, 'quien', 'Soy {{mi_nombre}}');
    expect(pick(await forConv(T.eve, conv), 'quien').text).toBe('Soy Eva Mora');
    // el administrador ve toda conversación pero usa SUS respuestas, no las de Carolina
    expect((await forConv(T.alice, conv)).map((q) => q.shortcut)).toEqual(['equipo']);
    expect((await call('GET', `/conversations/${NOBODY}/quick-replies`, T.alice)).status).toBe(404);
  });

  it('un contacto borrado no deja resolver (404) y las respuestas borradas no salen', async () => {
    const q = await mk(T.carol, 'hola', 'Hola');
    const { conv, contact } = await mkConv();
    expect((await forConv(T.carol, conv)).map((x) => x.shortcut)).toEqual(['hola']);
    await ok(await call('DELETE', `/quick-replies/${q.id}`, T.carol));
    expect(await forConv(T.carol, conv)).toEqual([]);
    await admin.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [contact]);
    expect((await call('GET', `/conversations/${conv}/quick-replies`, T.carol)).status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('base de datos', () => {
  it('la tabla tiene RLS forzada y la aplicación no puede borrar filas (solo marcarlas)', async () => {
    const t = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'quick_replies'`)).rows[0];
    expect(t).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const privs = (await admin.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'quick_replies' AND grantee = 'app_rw' ORDER BY 1`)).rows.map((r) => r.privilege_type as string);
    expect(privs).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    const q = await mk(T.carol, 'hola', 'Hola');
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
      expect((await c.query('SELECT id FROM quick_replies WHERE id = $1', [q.id])).rowCount).toBe(0); // la RLS esconde la fila de A bajo el contexto de B
      await c.query('ROLLBACK');
      await expect(c.query('DELETE FROM quick_replies')).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });
});
