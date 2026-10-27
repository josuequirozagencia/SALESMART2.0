// M7.3 — Etiquetas bidireccionales con GoHighLevel y anti-eco (ADR-52). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/ghl/outbox
//   POST /v1/ghl/outbox/:id/retry
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { Database, DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { FakeGhlProvider, GHL_OUTBOX_MAX_ATTEMPTS, GhlError, GhlEventsService, GhlModule, GhlOutboxJob, GhlOutboxService } from '../../src/modules/ghl';
import { OrganizationsModule } from '../../src/modules/organizations';
import { SystemTagsService } from '../../src/modules/tags';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

const fake = new FakeGhlProvider();

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, GhlModule.register({ provider: fake }), HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
};
const KEY = randomBytes(32).toString('base64');
const TOKEN = 'pit-aaaaaaaa-1111-4222-8333-alicia0123456789';
const LOC_A = 've9EPM428h8vShlRW1KT';
const LOC_B = 'Zk3Rm91QpWxYtLuNc7Aa';
const PHONE = '+593984217730';
const GHL_ANA = 'ghlAna0000000001';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
let hookA: { id: string; secret: string };
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE ghl_outbox, ghl_events, ghl_contact_links, ghl_connections, ghl_routes, contact_tags, tags, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin']] as const) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

type Row = Record<string, unknown>;
const hook = (h: { id: string; secret: string }, body: unknown) => call('POST', `/integrations/ghl/webhook/${h.id}`, undefined, body, { 'x-webhook-secret': h.secret });
const connect = async (token: string, loc: string) => expect((await call('PUT', '/ghl/connection', token, { location_id: loc, access_token: TOKEN })).status).toBe(200);
const issue = async (token: string) => json<{ id: string; secret: string }>(await call('POST', '/ghl/webhook/secret', token));

/** Hora «de la tarea»: un poco después de ahora (las filas se guardan con la hora real). */
const later = (ms = 60_000) => new Date(Date.now() + ms);
const inOrg = <R,>(org: string, fn: () => Promise<R>): Promise<R> => TenantContext.run({ organizationId: org, userId: org === ORG_A ? IDS.alice : IDS.bob }, fn);
const sendOut = (org = ORG_A, at: Date = later()) => inOrg(org, () => app.get(GhlOutboxService).runDue(at));
const applyIn = (org = ORG_A, at: Date = later()) => inOrg(org, () => app.get(GhlEventsService).runDue(at));
const outbox = async (org = ORG_A) => (await admin.query(`SELECT * FROM ghl_outbox WHERE organization_id = $1 ORDER BY created_at, id`, [org])).rows as Row[];
const links = async (org = ORG_A) => (await admin.query(`SELECT * FROM ghl_contact_links WHERE organization_id = $1`, [org])).rows as Row[];

const newTag = async (token: string, name: string): Promise<string> => {
  const r = await call('POST', '/tags', token, { name });
  expect(r.status, `tag ${name}`).toBe(201);
  return (await json<{ id: string }>(r)).id;
};
const newContact = async (token: string, name: string, phone: string | null = PHONE, tagIds: string[] = []): Promise<string> => {
  const r = await call('POST', '/contacts', token, { name, ...(phone ? { phones: [phone] } : {}), ...(tagIds.length ? { tag_ids: tagIds } : {}) });
  expect(r.status, `contacto ${name}`).toBe(201);
  return (await json<{ id: string }>(r)).id;
};
const setTags = async (token: string, id: string, tagIds: string[]) => expect((await call('PATCH', `/contacts/${id}`, token, { tag_ids: tagIds })).status).toBe(200);
const tagNames = async (id: string): Promise<string[]> =>
  (await admin.query(`SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id AND t.organization_id = ct.organization_id WHERE ct.contact_id = $1 ORDER BY t.name`, [id])).rows.map((r) => r.name as string);
/** Un contacto de la empresa ya vinculado a un contacto de GHL (como si hubiera llegado un aviso). */
const linked = async (name = 'Ana Torres', ghlId = GHL_ANA, phone = PHONE): Promise<string> => {
  const id = await newContact(T.alice, name, phone);
  await admin.query(`INSERT INTO ghl_contact_links(id, organization_id, ghl_contact_id, contact_id, tags) VALUES (gen_random_uuid(), $1, $2, $3, '[]'::jsonb)`, [ORG_A, ghlId, id]);
  return id;
};
const event = (over: Record<string, unknown> = {}) => ({ contact_id: GHL_ANA, full_name: 'Ana Torres', phone: PHONE, ...over });
const status = async () => (await call('GET', '/ghl/connection', T.alice).then((r) => json<{ status: string }>(r))).status;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'WHATSAPP_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test') };
  await connect(T.alice, LOC_A);
  await connect(T.bob, LOC_B);
  hookA = await issue(T.alice);
  await issue(T.bob);
  fake.calls.length = 0;
  fake.existingByPhone.clear();
});

describe('salida: lo que se etiqueta aquí llega a GoHighLevel', () => {
  it('poner una etiqueta personalizada la anota en la cola en la MISMA transacción y la tarea la envía al contacto de GHL vinculado', async () => {
    const id = await linked();
    const vip = await newTag(T.alice, 'VIP');
    await setTags(T.alice, id, [vip]);
    const [row] = await outbox();
    expect(row).toMatchObject({ contact_id: id, op: 'tag_add', tag_name: 'VIP', tag_kind: 'custom', status: 'pending', attempts: 0 });
    expect(fake.calls).toHaveLength(0); // anotar no es enviar: lo hace la tarea
    expect(await sendOut()).toBe(1);
    expect(fake.calls).toEqual([expect.objectContaining({ kind: 'addTags', contactId: GHL_ANA, tags: ['VIP'], credentials: { locationId: LOC_A, accessToken: TOKEN } })]);
    expect((await outbox())[0]).toMatchObject({ status: 'done', attempts: 1, last_error: null, note: null });
    expect((await links())[0]!['tags']).toEqual(['vip']); // el estado de sincronización ya refleja lo enviado
  });

  it('quitar una etiqueta se envía como «quitar»; repetir el mismo conjunto no anota nada', async () => {
    const id = await linked();
    const vip = await newTag(T.alice, 'VIP');
    await setTags(T.alice, id, [vip]);
    await sendOut();
    await setTags(T.alice, id, [vip]); // sin cambio
    expect(await outbox()).toHaveLength(1);
    await setTags(T.alice, id, []);
    expect((await outbox()).map((r) => r['op'])).toEqual(['tag_add', 'tag_remove']);
    await sendOut(ORG_A, later(120_000));
    expect(fake.calls.map((c) => c.kind)).toEqual(['addTags', 'removeTags']);
    expect((await links())[0]!['tags']).toEqual([]);
  });

  it('un contacto que aún no está en GHL se busca o crea por teléfono al AGREGAR una etiqueta, se vincula, y la siguiente usa el vínculo', async () => {
    const id = await newContact(T.alice, PHONE, PHONE); // se llama como su teléfono: no se manda como nombre
    const a = await newTag(T.alice, 'Frecuente');
    const b = await newTag(T.alice, 'Corte');
    await setTags(T.alice, id, [a]);
    await sendOut();
    expect(fake.calls.map((c) => c.kind)).toEqual(['upsertContact', 'addTags']);
    expect(fake.calls[0]).toMatchObject({ kind: 'upsertContact', input: { name: null, phone: PHONE, email: null } });
    const [link] = await links();
    expect(link).toMatchObject({ contact_id: id, ghl_contact_id: 'FakeGhlContact000001', tags: null });
    expect(fake.calls[1]).toMatchObject({ kind: 'addTags', contactId: 'FakeGhlContact000001', tags: ['Frecuente'] });
    await setTags(T.alice, id, [a, b]);
    await sendOut(ORG_A, later(120_000));
    expect(fake.calls.map((c) => c.kind)).toEqual(['upsertContact', 'addTags', 'addTags']); // sin otro upsert
  });

  it('con nombre propio y correo, esos datos van en el alta; si GHL ya tiene a esa persona por teléfono, se vincula a la existente', async () => {
    fake.existingByPhone.set(PHONE, 'GhlYaExistia0001');
    const id = await newContact(T.alice, 'Ana Torres');
    await call('PATCH', `/contacts/${id}`, T.alice, { email: 'ana@correo.test' });
    await setTags(T.alice, id, [await newTag(T.alice, 'VIP')]);
    await sendOut();
    expect(fake.calls[0]).toMatchObject({ kind: 'upsertContact', input: { name: 'Ana Torres', phone: PHONE, email: 'ana@correo.test' } });
    expect((await links())[0]).toMatchObject({ ghl_contact_id: 'GhlYaExistia0001', contact_id: id });
  });

  it('quitar una etiqueta de alguien que no está en GHL se omite con su motivo y NO lo crea allá', async () => {
    const id = await newContact(T.alice, 'Sin vínculo');
    await admin.query(`INSERT INTO ghl_outbox(id, organization_id, contact_id, op, tag_name, tag_kind) VALUES (gen_random_uuid(), $1, $2, 'tag_remove', 'VIP', 'custom')`, [ORG_A, id]);
    await sendOut();
    expect(fake.calls).toEqual([]);
    expect((await outbox())[0]).toMatchObject({ status: 'skipped' });
    expect((await outbox())[0]!['note']).toContain('no hay etiqueta que quitar');
    expect(await links()).toEqual([]);
  });

  it('un contacto sin teléfono ni correo y sin vínculo no se puede crear en GHL: se omite con su motivo', async () => {
    const id = await newContact(T.alice, 'Sin datos', null);
    await setTags(T.alice, id, [await newTag(T.alice, 'VIP')]);
    await sendOut();
    expect(fake.calls).toEqual([]);
    expect((await outbox())[0]).toMatchObject({ status: 'skipped' });
    expect((await outbox())[0]!['note']).toContain('ni correo');
  });

  it('las etiquetas del SISTEMA (Lead, Cita agendada, Venta) también salen hacia GHL, con su nombre', async () => {
    const id = await linked();
    await inOrg(ORG_A, () => app.get(Database).withTenant((tx) => app.get(SystemTagsService).apply(tx, id, 'lead')));
    await inOrg(ORG_A, () => app.get(Database).withTenant((tx) => app.get(SystemTagsService).apply(tx, id, 'sale')));
    await inOrg(ORG_A, () => app.get(Database).withTenant((tx) => app.get(SystemTagsService).apply(tx, id, 'sale'))); // idempotente: no repite
    expect((await outbox()).map((r) => [r['tag_name'], r['tag_kind']])).toEqual([['Lead', 'system'], ['Venta', 'system']]);
    await sendOut();
    await sendOut(ORG_A, later(120_000));
    expect(fake.calls.map((c) => (c.kind === 'addTags' ? c.tags[0] : c.kind))).toEqual(['Lead', 'Venta']);
  });

  it('el orden por contacto se respeta: de a un cambio por pasada, en el orden en que ocurrieron; otros contactos no esperan', async () => {
    const one = await linked();
    const two = await linked('Beto Cliente', 'ghlBeto000000001', '+593922222222');
    const vip = await newTag(T.alice, 'VIP');
    await setTags(T.alice, one, [vip]);
    await setTags(T.alice, one, []);
    await setTags(T.alice, one, [vip]);
    await setTags(T.alice, two, [vip]);
    expect(await sendOut(ORG_A, later(60_000))).toBe(2); // el primero de «one» y el de «two»
    expect(fake.calls.map((c) => [c.kind, (c as { contactId: string }).contactId])).toEqual([['addTags', GHL_ANA], ['addTags', 'ghlBeto000000001']]);
    expect(await sendOut(ORG_A, later(120_000))).toBe(1);
    expect(await sendOut(ORG_A, later(180_000))).toBe(1);
    expect(fake.calls.map((c) => c.kind)).toEqual(['addTags', 'addTags', 'removeTags', 'addTags']);
    expect(await sendOut(ORG_A, later(240_000))).toBe(0);
  });

  it('un fallo pasajero reintenta con espera creciente y mantiene el orden; al recuperarse sale', async () => {
    const id = await linked();
    const vip = await newTag(T.alice, 'VIP');
    await setTags(T.alice, id, [vip]);
    await setTags(T.alice, id, []);
    fake.failNextCall(new GhlError('GoHighLevel no pudo atender la llamada ahora', true));
    const t0 = later();
    expect(await sendOut(ORG_A, t0)).toBe(1);
    const [first, second] = await outbox();
    expect(first).toMatchObject({ status: 'pending', attempts: 1 });
    expect(second).toMatchObject({ status: 'pending', attempts: 0 });
    expect(new Date(first!['next_attempt_at'] as Date).getTime()).toBeGreaterThan(t0.getTime());
    expect(await sendOut(ORG_A, new Date(t0.getTime() + 1_000))).toBe(0); // en espera: ni el primero ni el segundo (que va detrás)
    const t1 = new Date(new Date(first!['next_attempt_at'] as Date).getTime() + 1);
    expect(await sendOut(ORG_A, t1)).toBe(1);
    expect(await sendOut(ORG_A, new Date(t1.getTime() + 60_000))).toBe(1);
    expect(fake.calls.map((c) => c.kind)).toEqual(['addTags', 'removeTags']);
    expect((await outbox()).map((r) => r['status'])).toEqual(['done', 'done']);
  });

  it('tras el máximo de intentos pasajeros queda «failed», sin teléfonos ni correos en el error; el panel permite reintentarlo', async () => {
    const id = await linked();
    await setTags(T.alice, id, [await newTag(T.alice, 'VIP')]);
    let at = later();
    for (let i = 0; i < GHL_OUTBOX_MAX_ATTEMPTS; i++) {
      fake.failNextCall(new GhlError('GoHighLevel no pudo atender la llamada ahora', true));
      expect(await sendOut(ORG_A, at)).toBe(1);
      const row = (await outbox())[0]!;
      at = new Date(Math.max(new Date(row['next_attempt_at'] as Date).getTime(), at.getTime()) + 1);
    }
    const failed = (await outbox())[0]!;
    expect(failed).toMatchObject({ status: 'failed', attempts: GHL_OUTBOX_MAX_ATTEMPTS });
    expect(JSON.stringify(failed['last_error'])).not.toMatch(/593|ana@/);
    expect(await sendOut(ORG_A, at)).toBe(0);
    const r = await call('POST', `/ghl/outbox/${failed['id'] as string}/retry`, T.alice);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ id: failed['id'], status: 'pending' });
    expect(await sendOut(ORG_A, new Date(at.getTime() + 1_000))).toBe(1);
    expect((await outbox())[0]).toMatchObject({ status: 'done', last_error: null });
  });

  it('un fallo definitivo (GHL rechaza la solicitud o el contacto ya no existe allá) marca «failed» enseguida, con el motivo', async () => {
    const id = await linked();
    await setTags(T.alice, id, [await newTag(T.alice, 'VIP')]);
    fake.failNextCall(new GhlError('GoHighLevel no encuentra el contacto', false));
    await sendOut();
    expect((await outbox())[0]).toMatchObject({ status: 'failed', attempts: 1, last_error: 'GoHighLevel no encuentra el contacto' });
  });

  it('si GHL rechaza el token, la conexión pasa a «requiere reconexión», lo anotado ESPERA sin gastar intentos y, al reconectar, sale', async () => {
    const id = await linked();
    const vip = await newTag(T.alice, 'VIP');
    await setTags(T.alice, id, [vip]);
    await setTags(T.alice, id, []);
    fake.failNextCall(new GhlError('GoHighLevel rechazó el token o no encuentra la Location', false, true));
    expect(await sendOut()).toBe(1);
    expect(await status()).toBe('needs_reconnect');
    expect((await outbox()).map((r) => [r['status'], r['attempts']])).toEqual([['pending', 0], ['pending', 0]]);
    expect(await sendOut(ORG_A, later(120_000))).toBe(0); // sin conexión activa no hace nada
    // mientras esté en «requiere reconexión» los cambios nuevos se siguen anotando
    await setTags(T.alice, id, [vip]);
    expect(await outbox()).toHaveLength(3);
    const audit = (await admin.query(`SELECT source, old_value, new_value FROM audit_logs WHERE entity_type = 'ghl_connection' AND field = 'status'`)).rows;
    expect(audit).toEqual([{ source: 'ghl', old_value: 'active', new_value: 'needs_reconnect' }]);
    await connect(T.alice, LOC_A);
    for (let i = 0; i < 3; i++) await sendOut(ORG_A, later(180_000 + i * 60_000));
    expect(fake.calls.map((c) => c.kind)).toEqual(['addTags', 'removeTags', 'addTags']);
  });

  it('desconectada, los cambios de etiqueta NO se anotan (no hay a dónde enviarlos)', async () => {
    const id = await linked();
    await call('POST', '/ghl/connection/disconnect', T.alice);
    await setTags(T.alice, id, [await newTag(T.alice, 'VIP')]);
    expect(await outbox()).toEqual([]);
    expect(await sendOut()).toBe(0);
  });

  it('un contacto borrado antes del envío se omite', async () => {
    const id = await linked();
    await setTags(T.alice, id, [await newTag(T.alice, 'VIP')]);
    await admin.query(`UPDATE contacts SET deleted_at = now() WHERE id = $1`, [id]);
    await sendOut();
    expect((await outbox())[0]).toMatchObject({ status: 'skipped', note: 'El contacto ya no existe' });
    expect(fake.calls).toEqual([]);
  });

  it('si el contacto de GHL que devuelve la búsqueda ya está vinculado a OTRO contacto de aquí, se omite sin crear un segundo vínculo', async () => {
    fake.existingByPhone.set('+593911111111', GHL_ANA);
    await linked();
    const other = await newContact(T.alice, 'Otro', '+593911111111');
    await setTags(T.alice, other, [await newTag(T.alice, 'VIP')]);
    await sendOut();
    expect((await outbox())[0]).toMatchObject({ status: 'skipped' });
    expect((await outbox())[0]!['note']).toContain('ya está vinculado a otro contacto');
    expect(await links()).toHaveLength(1);
  });

  it('la cola tiene una pasada por empresa con sus credenciales y la tarea recorre las empresas cliente', async () => {
    const a = await linked();
    const b = (await newContact(T.bob, 'Beto', '+593955555555'));
    await admin.query(`INSERT INTO ghl_contact_links(id, organization_id, ghl_contact_id, contact_id) VALUES (gen_random_uuid(), $1, 'ghlBetoBeto00001', $2)`, [ORG_B, b]);
    await setTags(T.alice, a, [await newTag(T.alice, 'VIP')]);
    await setTags(T.bob, b, [await newTag(T.bob, 'Mayorista')]);
    expect(await app.get(GhlOutboxJob).run(later())).toBe(2);
    const byCred = fake.calls.map((c) => [c.credentials.locationId, c.kind === 'addTags' ? c.tags[0] : c.kind]);
    expect(byCred).toEqual(expect.arrayContaining([[LOC_A, 'VIP'], [LOC_B, 'Mayorista']]));
    expect(await outbox(ORG_B)).toHaveLength(1);
  });
});

describe('borrar una etiqueta aquí la elimina también en GoHighLevel', () => {
  const del = (token: string, id: string) => call('DELETE', `/tags/${id}`, token);

  it('borrar una etiqueta personalizada anota el borrado (sin contacto) en la misma transacción; la tarea la elimina en GHL por nombre y la quita del estado de sincronización', async () => {
    const id = await linked();
    const vip = await newTag(T.alice, 'VIP');
    await setTags(T.alice, id, [vip]);
    await sendOut();
    expect((await links())[0]!['tags']).toEqual(['vip']);
    fake.existingTags.add('vip');
    expect((await del(T.alice, vip)).status).toBe(200);
    const rows = await outbox();
    expect(rows.at(-1)).toMatchObject({ op: 'tag_delete', contact_id: null, tag_name: 'VIP', tag_kind: 'custom', status: 'pending' });
    expect(await sendOut(ORG_A, later(120_000))).toBe(1);
    expect(fake.calls.at(-1)).toMatchObject({ kind: 'deleteTag', name: 'VIP', credentials: { locationId: LOC_A, accessToken: TOKEN } });
    expect((await outbox()).at(-1)).toMatchObject({ status: 'done', note: null });
    expect((await links())[0]!['tags']).toEqual([]);
  });

  it('si GHL ya no tenía la etiqueta queda hecho con una nota; sin contactos vinculados tampoco falla', async () => {
    const vip = await newTag(T.alice, 'VIP');
    await del(T.alice, vip);
    await sendOut();
    expect((await outbox())[0]).toMatchObject({ op: 'tag_delete', status: 'done', note: 'GoHighLevel no tenía esa etiqueta' });
  });

  it('los cambios pendientes de esa etiqueta se omiten (no se vuelve a crear allá) y los de otras etiquetas siguen', async () => {
    const id = await linked();
    const vip = await newTag(T.alice, 'VIP');
    const otra = await newTag(T.alice, 'Otra');
    await setTags(T.alice, id, [vip, otra]);
    await del(T.alice, vip);
    const rows = await outbox();
    expect(rows.map((r) => [r['op'], r['tag_name'], r['status']])).toEqual(expect.arrayContaining([['tag_add', 'VIP', 'skipped'], ['tag_add', 'Otra', 'pending'], ['tag_delete', 'VIP', 'pending']]));
    expect(rows.find((r) => r['tag_name'] === 'VIP' && r['op'] === 'tag_add')!['note']).toBe('La etiqueta se eliminó antes de enviarse');
    await sendOut();
    await sendOut(ORG_A, later(120_000));
    expect(fake.calls.some((c) => c.kind === 'addTags' && c.tags[0] === 'Otra')).toBe(true);
    expect(fake.calls.some((c) => c.kind === 'deleteTag' && c.name === 'VIP')).toBe(true);
    expect(fake.calls.some((c) => c.kind === 'addTags' && c.tags[0] === 'VIP')).toBe(false);
  });

  it('si se crea otra etiqueta con el mismo nombre, sus altas esperan a que termine el borrado (si no, el borrado se la llevaría)', async () => {
    const id = await linked();
    const old = await newTag(T.alice, 'VIP');
    await del(T.alice, old);
    const again = await newTag(T.alice, 'VIP');
    await setTags(T.alice, id, [again]);
    fake.failNextCall(new GhlError('GoHighLevel no pudo atender la llamada ahora', true));
    const t0 = later();
    expect(await sendOut(ORG_A, t0)).toBe(1); // solo el borrado, que falla de forma pasajera; el alta espera
    expect(fake.calls).toEqual([]);
    const [deletion, add] = await outbox();
    expect(deletion).toMatchObject({ op: 'tag_delete', status: 'pending', attempts: 1 });
    expect(add).toMatchObject({ op: 'tag_add', status: 'pending', attempts: 0 });
    const t1 = new Date(new Date(deletion!['next_attempt_at'] as Date).getTime() + 1);
    expect(await sendOut(ORG_A, t1)).toBe(1);
    expect(await sendOut(ORG_A, new Date(t1.getTime() + 60_000))).toBe(1);
    expect(fake.calls.map((c) => c.kind)).toEqual(['deleteTag', 'addTags']); // primero el borrado, luego el alta
  });

  it('un token sin el permiso de etiquetas (403) deja el borrado en «failed» con el motivo y NO marca la conexión como rechazada', async () => {
    const vip = await newTag(T.alice, 'VIP');
    await del(T.alice, vip);
    fake.failNextCall(new GhlError('El token no tiene permiso para esta operación en GoHighLevel (revisa los permisos de etiquetas de la integración)', false));
    await sendOut();
    expect((await outbox())[0]).toMatchObject({ status: 'failed' });
    expect((await outbox())[0]!['last_error']).toContain('permiso');
    expect(await status()).toBe('active');
  });

  it('si GHL rechaza el token, la conexión pide reconexión y el borrado espera sin gastar intentos', async () => {
    const vip = await newTag(T.alice, 'VIP');
    await del(T.alice, vip);
    fake.failNextCall(new GhlError('GoHighLevel rechazó el token o no encuentra la Location', false, true));
    await sendOut();
    expect(await status()).toBe('needs_reconnect');
    expect((await outbox())[0]).toMatchObject({ status: 'pending', attempts: 0 });
    await connect(T.alice, LOC_A);
    await sendOut(ORG_A, later(120_000));
    expect(fake.calls.map((c) => c.kind)).toEqual(['deleteTag']);
  });

  it('desconectada no se anota nada; las etiquetas del sistema no se pueden borrar (409) y no anotan nada', async () => {
    const vip = await newTag(T.alice, 'VIP');
    const sys = await call('GET', '/tags', T.alice).then((r) => json<{ items: Array<{ id: string; name: string }> }>(r));
    const venta = sys.items.find((t) => t.name === 'Venta')!;
    expect((await del(T.alice, venta.id)).status).toBe(409);
    expect(await outbox()).toEqual([]);
    await call('POST', '/ghl/connection/disconnect', T.alice);
    await del(T.alice, vip);
    expect(await outbox()).toEqual([]);
  });

  it('un aviso de GHL posterior sin esa etiqueta no rompe nada ni anota nada (la etiqueta ya no existe aquí)', async () => {
    const vip = await newTag(T.alice, 'VIP');
    await hook(hookA, event({ event_id: 'a', tags: ['vip'] }));
    await applyIn();
    await del(T.alice, vip);
    await sendOut(ORG_A, later(120_000));
    const before = (await outbox()).length;
    await hook(hookA, event({ event_id: 'b', tags: [] }));
    await applyIn(ORG_A, later(180_000));
    expect((await admin.query('SELECT status FROM ghl_events ORDER BY received_at')).rows.map((r) => r.status)).toEqual(['done', 'done']);
    expect(await outbox()).toHaveLength(before);
  });

  it('el panel lo muestra como «Eliminar» sin contacto; la base exige que el borrado no tenga contacto y los demás sí', async () => {
    const vip = await newTag(T.alice, 'VIP');
    await del(T.alice, vip);
    const body = await call('GET', '/ghl/outbox', T.alice).then((r) => json<{ items: Array<Record<string, unknown>> }>(r));
    expect(body.items[0]).toMatchObject({ op: 'tag_delete', tag: 'VIP', contact: null, status: 'pending', can_retry: false });
    const id = await newContact(T.alice, 'X');
    await expect(admin.query(`INSERT INTO ghl_outbox(id, organization_id, contact_id, op, tag_name, tag_kind) VALUES (gen_random_uuid(), '${ORG_A}', '${id}', 'tag_delete', 'VIP', 'custom')`)).rejects.toThrow(/ghl_outbox_contact_by_op/);
    await expect(admin.query(`INSERT INTO ghl_outbox(id, organization_id, op, tag_name, tag_kind) VALUES (gen_random_uuid(), '${ORG_A}', 'tag_add', 'VIP', 'custom')`)).rejects.toThrow(/ghl_outbox_contact_by_op/);
  });
});

describe('entrada: lo que GoHighLevel etiqueta llega aquí, sin eco', () => {
  it('un aviso con etiquetas agrega las que existen aquí (sin distinguir mayúsculas), ignora las desconocidas y las del sistema, y NADA vuelve a GHL', async () => {
    const vip = await newTag(T.alice, 'VIP');
    await newTag(T.alice, 'Nuevo');
    const sys = await call('GET', '/tags', T.alice).then((r) => json<{ items: Array<{ name: string }> }>(r));
    expect(sys.items.some((t) => t.name === 'Venta')).toBe(true);
    expect((await hook(hookA, event({ tags: 'vip, NUEVO, Venta, algo-desconocido' }))).status).toBe(200);
    await applyIn();
    const [c] = (await admin.query(`SELECT id FROM contacts WHERE organization_id = $1`, [ORG_A])).rows;
    expect(await tagNames(c.id)).toEqual(['Nuevo', 'VIP']);
    const [ev] = (await admin.query(`SELECT status, outcome, note FROM ghl_events WHERE organization_id = $1`, [ORG_A])).rows;
    expect(ev).toMatchObject({ status: 'done', outcome: 'contact_created' });
    expect(ev.note).toContain('2 agregada(s), 0 quitada(s)');
    expect(ev.note).toContain('2 etiqueta(s) de GoHighLevel sin equivalente');
    expect(await outbox()).toEqual([]); // anti-eco
    expect((await links())[0]!['tags']).toEqual(['vip', 'nuevo', 'venta', 'algo-desconocido']);
    const audit = (await admin.query(`SELECT source, old_value, new_value FROM audit_logs WHERE entity_type = 'contact' AND field = 'tags'`)).rows;
    expect(audit).toEqual([{ source: 'ghl', old_value: [], new_value: ['Nuevo', 'VIP'] }]);
    expect(vip).toBeTruthy();
  });

  it('la primera vez no hay con qué comparar: solo agrega. Después, lo que GHL ya no tiene se quita, y una lista vacía significa «sin etiquetas»', async () => {
    await newTag(T.alice, 'VIP');
    await newTag(T.alice, 'Nuevo');
    await hook(hookA, event({ event_id: 'e1', tags: ['vip', 'nuevo'] }));
    await applyIn();
    const id = (await admin.query(`SELECT contact_id FROM ghl_contact_links`)).rows[0].contact_id as string;
    expect(await tagNames(id)).toEqual(['Nuevo', 'VIP']);
    await hook(hookA, event({ event_id: 'e2', tags: ['vip'] }));
    await applyIn();
    expect(await tagNames(id)).toEqual(['VIP']);
    await hook(hookA, event({ event_id: 'e3', tags: [] }));
    await applyIn();
    expect(await tagNames(id)).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it('un aviso SIN el campo de etiquetas no toca nada (distinto de una lista vacía)', async () => {
    const vip = await newTag(T.alice, 'VIP');
    const id = await linked();
    await setTags(T.alice, id, [vip]);
    await admin.query(`UPDATE ghl_outbox SET status = 'done'`);
    await admin.query(`UPDATE ghl_contact_links SET tags = '["vip"]'::jsonb`);
    await hook(hookA, event({ event_id: 'sin-tags' }));
    await applyIn();
    expect(await tagNames(id)).toEqual(['VIP']);
    expect((await links())[0]!['tags']).toEqual(['vip']);
  });

  it('solo se quita lo que GHL tuvo y ya no tiene: una etiqueta que el equipo puso aquí a mano y GHL nunca conoció se queda', async () => {
    const vip = await newTag(T.alice, 'VIP');
    const manual = await newTag(T.alice, 'Manual');
    const id = await linked();
    await setTags(T.alice, id, [vip, manual]);
    await admin.query(`UPDATE ghl_outbox SET status = 'done'`);
    await admin.query(`UPDATE ghl_contact_links SET tags = '["vip"]'::jsonb`);
    await hook(hookA, event({ event_id: 'e', tags: [] }));
    await applyIn();
    expect(await tagNames(id)).toEqual(['Manual']);
  });

  it('las etiquetas del sistema no se tocan aunque GHL no las tenga o las quite', async () => {
    const id = await linked();
    await inOrg(ORG_A, () => app.get(Database).withTenant((tx) => app.get(SystemTagsService).apply(tx, id, 'sale')));
    await admin.query(`UPDATE ghl_outbox SET status = 'done'`);
    await admin.query(`UPDATE ghl_contact_links SET tags = '["venta"]'::jsonb`);
    await hook(hookA, event({ event_id: 'e', tags: [] }));
    await applyIn();
    expect(await tagNames(id)).toEqual(['Venta']);
  });

  it('un cambio local todavía por enviar tiene prioridad: un aviso anterior de GHL no lo deshace', async () => {
    const vip = await newTag(T.alice, 'VIP');
    const id = await linked();
    await admin.query(`UPDATE ghl_contact_links SET tags = '["vip"]'::jsonb`);
    await setTags(T.alice, id, [vip]); // agrega aquí (pendiente de enviar)
    await setTags(T.alice, id, []); // y quita
    await setTags(T.alice, id, [vip]); // y vuelve a agregar: hay filas pendientes de «VIP»
    await hook(hookA, event({ event_id: 'viejo', tags: [] })); // GHL aún cuenta que no la tiene
    await applyIn();
    expect(await tagNames(id)).toEqual(['VIP']);
    expect((await outbox()).every((r) => r['status'] === 'pending')).toBe(true);
  });

  it('ciclo completo sin eco: etiquetar aquí → sale a GHL → GHL avisa con esa etiqueta → no se anota nada nuevo; y al quitarla igual', async () => {
    await newTag(T.alice, 'VIP');
    await hook(hookA, event({ event_id: 'alta', tags: [] }));
    await applyIn();
    const id = (await admin.query(`SELECT contact_id FROM ghl_contact_links`)).rows[0].contact_id as string;
    const vip = (await admin.query(`SELECT id FROM tags WHERE name = 'VIP'`)).rows[0].id as string;
    await setTags(T.alice, id, [vip]);
    await sendOut();
    expect(fake.calls.map((c) => c.kind)).toEqual(['addTags']);
    await hook(hookA, event({ event_id: 'eco-1', tags: ['VIP'] })); // el aviso que GHL dispara por el cambio
    await applyIn();
    expect(await outbox()).toHaveLength(1); // nada nuevo
    expect(await tagNames(id)).toEqual(['VIP']);
    await setTags(T.alice, id, []);
    await sendOut(ORG_A, later(120_000));
    expect(fake.calls.map((c) => c.kind)).toEqual(['addTags', 'removeTags']);
    await hook(hookA, event({ event_id: 'eco-2', tags: [] }));
    await applyIn(ORG_A, later(180_000));
    expect(await outbox()).toHaveLength(2);
    expect(await tagNames(id)).toEqual([]);
  });

  it('el cambio que viene de GHL no se devuelve ni siquiera si se aplica varias veces (aviso repetido)', async () => {
    await newTag(T.alice, 'VIP');
    await hook(hookA, event({ event_id: 'r1', tags: ['vip'] }));
    await hook(hookA, event({ event_id: 'r2', tags: ['vip'] }));
    await applyIn();
    expect(await outbox()).toEqual([]);
    expect((await admin.query(`SELECT count(*)::int n FROM contact_tags WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(1);
  });
});

describe('panel, permisos y base de datos', () => {
  it('lista los cambios con su estado, el contacto y el motivo; filtra por estado, cuenta y pagina; sin teléfonos ni correos', async () => {
    const id = await linked();
    const none = await newContact(T.alice, 'Sin datos', null);
    const [a, b, c] = [await newTag(T.alice, 'A'), await newTag(T.alice, 'B'), await newTag(T.alice, 'C')];
    await setTags(T.alice, id, [a, b, c]);
    await setTags(T.alice, none, [a]);
    for (let i = 0; i < 3; i++) await sendOut(ORG_A, later(60_000 * (i + 1))); // de a un cambio por contacto en cada pasada
    const r = await call('GET', '/ghl/outbox', T.alice);
    expect(r.status).toBe(200);
    const body = await json<{ items: Array<Record<string, unknown>>; next_cursor: string | null; counts: Record<string, number> }>(r);
    expect(body.items).toHaveLength(4);
    expect(body.counts).toEqual({ done: 3, skipped: 1 });
    expect(body.items.find((i) => i['status'] === 'skipped')).toMatchObject({ tag: 'A', contact: { name: 'Sin datos' }, can_retry: false });
    // Sin ids ni fechas (un uuid o los milisegundos de una hora pueden contener «593» por azar): lo que no debe aparecer son teléfonos ni correos
    expect(JSON.stringify(body).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').replace(/d{4}-d{2}-d{2}T[d:.]+Z/g, '')).not.toMatch(/593|@/);
    const skipped = await call('GET', '/ghl/outbox?status=skipped', T.alice).then((x) => json<{ items: unknown[] }>(x));
    expect(skipped.items).toHaveLength(1);
    const p1 = await call('GET', '/ghl/outbox?limit=3', T.alice).then((x) => json<{ items: Array<{ id: string }>; next_cursor: string | null }>(x));
    expect(p1.items).toHaveLength(3);
    const p2 = await call('GET', `/ghl/outbox?limit=3&cursor=${p1.next_cursor}`, T.alice).then((x) => json<{ items: Array<{ id: string }>; next_cursor: string | null }>(x));
    expect(p2.items).toHaveLength(1);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(4);
    for (const bad of ['?status=raro', '?limit=0', '?cursor=basura', '?otro=1']) expect((await call('GET', `/ghl/outbox${bad}`, T.alice)).status, bad).toBe(400);
  });

  it('solo el administrador; reintentar solo lo fallido; cada empresa ve y toca solo lo suyo', async () => {
    const id = await linked();
    await setTags(T.alice, id, [await newTag(T.alice, 'VIP')]);
    const row = (await outbox())[0]!;
    expect((await call('GET', '/ghl/outbox')).status).toBe(401);
    expect((await call('GET', '/ghl/outbox', T.carol)).status).toBe(403);
    expect((await call('POST', `/ghl/outbox/${row['id'] as string}/retry`, T.carol)).status).toBe(403);
    const pending = await call('POST', `/ghl/outbox/${row['id'] as string}/retry`, T.alice);
    expect(pending.status).toBe(409);
    expect((await json<{ error: { code: string } }>(pending)).error.code).toBe('GHL_OUTBOX_NOT_FAILED');
    expect((await call('POST', `/ghl/outbox/${randomUUID()}/retry`, T.alice)).status).toBe(404);
    expect((await call('POST', `/ghl/outbox/no-es-uuid/retry`, T.alice)).status).toBe(400);
    await admin.query(`UPDATE ghl_outbox SET status = 'failed' WHERE id = $1`, [row['id']]);
    expect((await call('POST', `/ghl/outbox/${row['id'] as string}/retry`, T.bob)).status).toBe(404); // de otra empresa
    expect((await call('GET', '/ghl/outbox', T.bob).then((x) => json<{ items: unknown[] }>(x))).items).toEqual([]);
    expect((await call('POST', `/ghl/outbox/${row['id'] as string}/retry`, T.alice)).status).toBe(200);
  });

  it('ghl_outbox es de negocio: solo app_rw, sin DELETE ni TRUNCATE; las restricciones impiden filas incoherentes', async () => {
    const as = async (url: string, sql: string) => {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        return await c.query(sql);
      } finally {
        await c.end();
      }
    };
    await expect(as(info.rwUrl, 'DELETE FROM ghl_outbox')).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, 'TRUNCATE ghl_outbox')).rejects.toThrow(/permission denied/);
    for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, 'SELECT 1 FROM ghl_outbox')).rejects.toThrow(/permission denied/);
    const id = await newContact(T.alice, 'X');
    const ins = (cols: string, vals: string) => admin.query(`INSERT INTO ghl_outbox(id, organization_id, contact_id, ${cols}) VALUES (gen_random_uuid(), '${ORG_A}', '${id}', ${vals})`);
    await expect(ins('op, tag_name, tag_kind', `'tag_raro', 'VIP', 'custom'`)).rejects.toThrow(/ghl_outbox_op_valid/);
    await expect(ins('op, tag_name, tag_kind', `'tag_add', 'VIP', 'otro'`)).rejects.toThrow(/ghl_outbox_kind_valid/);
    await expect(ins('op, tag_name, tag_kind', `'tag_add', '', 'custom'`)).rejects.toThrow(/ghl_outbox_tag_shape/);
    await expect(ins('op, tag_name, tag_kind, status', `'tag_add', 'VIP', 'custom', 'raro'`)).rejects.toThrow(/ghl_outbox_status_valid/);
    // el contacto debe ser de la MISMA empresa (clave foránea compuesta)
    const other = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), '${ORG_B}', 'B') RETURNING id`)).rows[0].id as string;
    await expect(admin.query(`INSERT INTO ghl_outbox(id, organization_id, contact_id, op, tag_name, tag_kind) VALUES (gen_random_uuid(), '${ORG_A}', '${other}', 'tag_add', 'VIP', 'custom')`)).rejects.toThrow(/ghl_outbox_contact_fk/);
    await expect(admin.query(`UPDATE ghl_contact_links SET tags = '{"a":1}'::jsonb`)).resolves.toBeDefined(); // sin vínculos no hay filas que violen
    await admin.query(`INSERT INTO ghl_contact_links(id, organization_id, ghl_contact_id, contact_id) VALUES (gen_random_uuid(), '${ORG_A}', 'ghlCheck00000001', '${id}')`);
    await expect(admin.query(`UPDATE ghl_contact_links SET tags = '{"a":1}'::jsonb WHERE ghl_contact_id = 'ghlCheck00000001'`)).rejects.toThrow(/ghl_contact_links_tags_array/);
  });
});
