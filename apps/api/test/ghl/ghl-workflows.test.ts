// M7.5 — Inscripción de contactos en flujos (Workflows) de GoHighLevel (ADR-52). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/ghl/workflows
//   POST /v1/ghl/contacts/:contactId/workflows
//   GET /v1/ghl/contacts/:contactId/workflows
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
import { ContactsModule } from '../../src/modules/contacts';
import { FakeGhlProvider, GhlError, GhlModule, GhlWorkflowsService } from '../../src/modules/ghl';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
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
const WF = 'wf000000000001';
const WF2 = 'wf000000000002';
const WF_DRAFT = 'wf000000000003';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE ghl_enrollments, ghl_outbox, ghl_events, ghl_contact_links, ghl_connections, ghl_routes, contact_tags, tags, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
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

type Row = Record<string, unknown>;
const json = async <X,>(r: Response): Promise<X> => (await r.json()) as X;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const connect = async (token: string, loc: string) => expect((await call('PUT', '/ghl/connection', token, { location_id: loc, access_token: TOKEN })).status).toBe(200);
const newContact = async (token: string, name: string, phone?: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await call('POST', '/contacts', token, { name, ...(phone ? { phones: [phone] } : {}), ...extra });
  expect(r.status, `crear ${name}`).toBe(201);
  return (await json<{ id: string }>(r)).id;
};
const enroll = (token: string, contactId: string, workflowId: string = WF) => call('POST', `/ghl/contacts/${contactId}/workflows`, token, { workflow_id: workflowId });
const history = (token: string, contactId: string) => call('GET', `/ghl/contacts/${contactId}/workflows`, token).then((r) => json<{ items: Array<Row> }>(r));
const calls = (kind: string) => fake.calls.filter((c) => c.kind === kind);
const connStatus = async (token = T.alice) => (await call('GET', '/ghl/connection', token).then((r) => json<{ status: string }>(r))).status;
const rows = async (org = ORG_A) => (await admin.query(`SELECT * FROM ghl_enrollments WHERE organization_id = $1 ORDER BY created_at, id`, [org])).rows as Row[];

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
  fake.calls.length = 0;
  fake.existingByPhone.clear();
  app.get(GhlWorkflowsService).clearCache();
  fake.workflows = [
    { id: WF, name: 'Bienvenida', status: 'published' },
    { id: WF2, name: 'Seguimiento de citas', status: 'published' },
    { id: WF_DRAFT, name: 'Borrador interno', status: 'draft' },
  ];
});

describe('lista de flujos', () => {
  it('GET /ghl/workflows: el administrador y el asesor la ven; sin sesión 401; marca cuáles se pueden usar y no muestra el token', async () => {
    expect((await call('GET', '/ghl/workflows')).status).toBe(401);
    for (const t of [T.alice, T.carol]) {
      const r = await call('GET', '/ghl/workflows', t);
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      const body = await json<{ items: Array<Row>; fetched_at: string }>(r);
      expect(body.items).toEqual([
        { id: WF, name: 'Bienvenida', enrollable: true },
        { id: WF2, name: 'Seguimiento de citas', enrollable: true },
        { id: WF_DRAFT, name: 'Borrador interno', enrollable: false },
      ]);
      expect(Number.isNaN(Date.parse(body.fetched_at))).toBe(false);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    }
  });

  it('se guarda en memoria 5 min por empresa; «refresh» la salta; cada empresa ve SUS flujos', async () => {
    await call('GET', '/ghl/workflows', T.alice);
    await call('GET', '/ghl/workflows', T.carol);
    expect(calls('listWorkflows')).toHaveLength(1);
    fake.workflows = [{ id: 'wfNuevo000001', name: 'Nuevo', status: 'published' }];
    expect((await call('GET', '/ghl/workflows', T.alice).then((r) => json<{ items: Array<Row> }>(r))).items).toHaveLength(3); // sigue la memoria
    const fresh = await call('GET', '/ghl/workflows?refresh=1', T.alice).then((r) => json<{ items: Array<Row> }>(r));
    expect(fresh.items).toEqual([{ id: 'wfNuevo000001', name: 'Nuevo', enrollable: true }]);
    expect(calls('listWorkflows')).toHaveLength(2);
    // la otra empresa tiene su propia memoria y su propia Location
    const b = await call('GET', '/ghl/workflows', T.bob).then((r) => json<{ items: Array<Row> }>(r));
    expect(b.items).toEqual([{ id: 'wfNuevo000001', name: 'Nuevo', enrollable: true }]);
    expect(calls('listWorkflows').map((c) => (c as { credentials: { locationId: string } }).credentials.locationId)).toEqual([LOC_A, LOC_A, LOC_B]);
  });

  it('parámetros no válidos son 400', async () => {
    expect((await call('GET', '/ghl/workflows?refresh=si', T.alice)).status).toBe(400);
    expect((await call('GET', '/ghl/workflows?otro=1', T.alice)).status).toBe(400);
  });

  it('sin conexión (o con el token rechazado) es 409 y no llama a GHL; si GHL rechaza el token, la conexión pide reconexión', async () => {
    await call('POST', '/ghl/connection/disconnect', T.alice);
    const off = await call('GET', '/ghl/workflows', T.alice);
    expect(off.status).toBe(409);
    expect(await json(off)).toMatchObject({ error: { code: 'GHL_NOT_CONNECTED' } });
    expect(calls('listWorkflows')).toHaveLength(0);
    await connect(T.alice, LOC_A);
    fake.failNextCall(new GhlError('GoHighLevel rechazó el token', false, true));
    expect((await call('GET', '/ghl/workflows?refresh=1', T.alice)).status).toBe(409);
    expect(await connStatus()).toBe('needs_reconnect');
  });

  it('un fallo pasajero es 503; uno definitivo (por ejemplo, un token sin permiso de workflows) es 409 con el motivo y NO desconecta', async () => {
    fake.failNextCall(new GhlError('GoHighLevel no pudo atender la llamada ahora', true));
    expect((await call('GET', '/ghl/workflows', T.alice)).status).toBe(503);
    fake.failNextCall(new GhlError('El token no tiene permiso para esta operación en GoHighLevel', false));
    const r = await call('GET', '/ghl/workflows', T.alice);
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ error: { code: 'GHL_REJECTED' } });
    expect(await connStatus()).toBe('active');
  });
});

describe('inscribir a un contacto', () => {
  it('un contacto que aún no está en GHL se busca o crea por teléfono, queda vinculado y se inscribe; el resultado se ve, se guarda y se audita', async () => {
    const id = await newContact(T.alice, 'Ana Torres', '+593984217730');
    const r = await enroll(T.alice, id);
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const out = await json<Row>(r);
    expect(out).toMatchObject({ workflow: { id: WF, name: 'Bienvenida' }, status: 'done', error: null, by: { id: IDS.alice, name: 'Alicia Torres' } });
    const up = calls('upsertContact');
    expect(up).toHaveLength(1);
    expect(up[0]).toMatchObject({ input: { name: 'Ana Torres', phone: '+593984217730' } });
    const link = (await admin.query(`SELECT ghl_contact_id FROM ghl_contact_links WHERE contact_id = $1`, [id])).rows[0] as Row;
    expect(link['ghl_contact_id']).toMatch(/^FakeGhlContact/);
    expect(calls('enrollInWorkflow')[0]).toMatchObject({ ghlContactId: link['ghl_contact_id'], workflowId: WF });
    expect(await rows()).toHaveLength(1);
    expect((await history(T.alice, id)).items).toEqual([out]);
    const audit = (await admin.query(`SELECT entity_type, field, new_value, actor_user_id FROM audit_logs WHERE entity_id = $1 AND field = 'ghl_workflow'`, [id])).rows as Row[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity_type: 'contact', actor_user_id: IDS.alice, new_value: { workflow_id: WF, workflow_name: 'Bienvenida', result: 'done' } });
  });

  it('un contacto ya vinculado no se vuelve a buscar en GHL; el mismo contacto puede entrar a otro flujo', async () => {
    const id = await newContact(T.alice, 'Ana Torres', '+593984217730');
    expect((await enroll(T.alice, id)).status).toBe(201);
    fake.calls.length = 0;
    expect((await enroll(T.alice, id, WF2)).status).toBe(201);
    expect(calls('upsertContact')).toHaveLength(0);
    expect(calls('enrollInWorkflow')).toHaveLength(1);
    expect((await history(T.alice, id)).items.map((i) => (i['workflow'] as { id: string }).id)).toEqual([WF2, WF]); // el más reciente primero
  });

  it('el mismo flujo dos veces seguidas (doble clic) es 409 y no llama a GHL otra vez', async () => {
    const id = await newContact(T.alice, 'Ana Torres', '+593984217730');
    expect((await enroll(T.alice, id)).status).toBe(201);
    fake.calls.length = 0;
    const again = await enroll(T.alice, id);
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ error: { code: 'GHL_ALREADY_ENROLLED' } });
    expect(calls('enrollInWorkflow')).toHaveLength(0);
    expect(await rows()).toHaveLength(1);
    // pasado el margen, se puede volver a inscribir
    await admin.query(`UPDATE ghl_enrollments SET created_at = now() - interval '2 minutes'`);
    expect((await enroll(T.alice, id)).status).toBe(201);
  });

  it('un flujo que no existe, o que está en borrador, o un cuerpo malo: 400, sin llamar a GHL para inscribir y sin registro', async () => {
    const id = await newContact(T.alice, 'Ana Torres', '+593984217730');
    expect((await enroll(T.alice, id, 'wfInexistente1')).status).toBe(400);
    const draft = await enroll(T.alice, id, WF_DRAFT);
    expect(draft.status).toBe(400);
    expect(JSON.stringify(await json(draft))).toContain('workflow_id');
    for (const body of [{}, { workflow_id: '' }, { workflow_id: '../x' }, { workflow_id: WF, otro: 1 }, { workflow_id: 7 }]) expect((await call('POST', `/ghl/contacts/${id}/workflows`, T.alice, body)).status, JSON.stringify(body)).toBe(400);
    expect((await call('POST', '/ghl/contacts/no-es-uuid/workflows', T.alice, { workflow_id: WF })).status).toBe(400);
    expect(calls('enrollInWorkflow')).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it('un rechazo definitivo de GHL (por ejemplo, el flujo ya no existe allá) se devuelve con su motivo y queda registrado como fallido', async () => {
    const id = await newContact(T.alice, 'Ana Torres', '+593984217730');
    await call('GET', '/ghl/workflows', T.alice); // la lista queda en memoria
    fake.failNextCall(new GhlError('GoHighLevel no encuentra el contacto, el flujo o la Location', false)); // lo consume la búsqueda del contacto
    fake.failNextCall(new GhlError('GoHighLevel rechazó la solicitud: el contacto ya está en el flujo', false)); // y esta la inscripción
    // la primera falla corresponde a upsertContact (contacto sin vincular): se registra como fallido con ese motivo
    const first = await json<Row>(await enroll(T.alice, id));
    expect(first).toMatchObject({ status: 'failed' });
    expect(String(first['error'])).toContain('no encuentra');
    const second = await json<Row>(await enroll(T.alice, id, WF2));
    expect(second).toMatchObject({ status: 'failed' });
    expect(String(second['error'])).toContain('ya está en el flujo');
    expect((await history(T.alice, id)).items.map((i) => i['status'])).toEqual(['failed', 'failed']);
    expect(await connStatus()).toBe('active');
    // un intento fallido no bloquea el reintento inmediato (solo los exitosos cuentan para el margen)
    expect((await json<Row>(await enroll(T.alice, id, WF2)))['status']).toBe('done');
  });

  it('un fallo pasajero es 503 y NO se registra (la persona reintenta sin llenar el historial)', async () => {
    const id = await newContact(T.alice, 'Ana Torres', '+593984217730');
    fake.failNextCall(new GhlError('GoHighLevel no pudo atender la llamada ahora', true));
    expect((await enroll(T.alice, id)).status).toBe(503);
    expect(await rows()).toHaveLength(0);
    expect((await enroll(T.alice, id)).status).toBe(201);
  });

  it('si GHL rechaza el token al inscribir, queda registrado como fallido y la conexión pide reconexión', async () => {
    const id = await newContact(T.alice, 'Ana Torres', '+593984217730');
    await call('GET', '/ghl/workflows', T.alice);
    fake.failNextCall(new GhlError('GoHighLevel rechazó el token', false, true));
    const r = await json<Row>(await enroll(T.alice, id));
    expect(r).toMatchObject({ status: 'failed' });
    expect(await connStatus()).toBe('needs_reconnect');
    expect((await enroll(T.alice, id)).status).toBe(409); // ya no hay conexión activa
  });

  it('sin teléfono ni correo no se puede buscar ni crear en GHL: queda fallido con ese motivo', async () => {
    const id = await newContact(T.alice, 'Sin datos');
    const r = await json<Row>(await enroll(T.alice, id));
    expect(r).toMatchObject({ status: 'failed' });
    expect(String(r['error'])).toContain('teléfono ni correo');
    expect(calls('upsertContact')).toHaveLength(0);
  });

  it('con un correo (sin teléfono) también se busca o crea', async () => {
    const id = await newContact(T.alice, 'Con correo', undefined, { email: 'ana@example.com' });
    expect((await json<Row>(await enroll(T.alice, id)))['status']).toBe('done');
    expect(calls('upsertContact')[0]).toMatchObject({ input: { phone: null, email: 'ana@example.com' } });
  });

  it('sin conexión activa es 409 y no registra nada', async () => {
    const id = await newContact(T.alice, 'Ana Torres', '+593984217730');
    await call('POST', '/ghl/connection/disconnect', T.alice);
    const r = await enroll(T.alice, id);
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ error: { code: 'GHL_NOT_CONNECTED' } });
    expect(await rows()).toHaveLength(0);
  });

  it('si el contacto de GHL ya pertenece a OTRO contacto de aquí, se inscribe igual pero no se vincula', async () => {
    const a = await newContact(T.alice, 'Ana Torres', '+593984217730');
    const b = await newContact(T.alice, 'Ana Duplicada', '+593984217731');
    fake.existingByPhone.set('+593984217731', 'ghlYaExiste0001');
    await admin.query(`INSERT INTO ghl_contact_links(id, organization_id, ghl_contact_id, contact_id) VALUES (gen_random_uuid(), $1, 'ghlYaExiste0001', $2)`, [ORG_A, a]);
    expect((await enroll(T.alice, b)).status).toBe(201);
    expect((await admin.query(`SELECT count(*)::int AS n FROM ghl_contact_links WHERE contact_id = $1`, [b])).rows[0].n).toBe(0);
    expect(calls('enrollInWorkflow')[0]).toMatchObject({ ghlContactId: 'ghlYaExiste0001' });
  });
});

describe('permisos y aislamiento', () => {
  it('el asesor solo inscribe (y ve el historial de) los contactos que ve: los suyos sí, los de otros 404', async () => {
    const mine = await newContact(T.carol, 'De Carolina', '+593984217730');
    const hers = await newContact(T.alice, 'De la administradora', '+593984217731');
    await admin.query(`UPDATE contacts SET owner_id = $1 WHERE id = $2`, [IDS.alice, hers]);
    expect((await enroll(T.carol, mine)).status).toBe(201);
    expect((await json<{ items: Array<Row> }>(await call('GET', `/ghl/contacts/${mine}/workflows`, T.carol))).items).toHaveLength(1);
    fake.calls.length = 0;
    expect((await enroll(T.carol, hers)).status).toBe(404);
    expect((await call('GET', `/ghl/contacts/${hers}/workflows`, T.carol)).status).toBe(404);
    expect(calls('enrollInWorkflow')).toHaveLength(0);
    expect((await enroll(T.alice, hers)).status).toBe(201); // quien ve todo, sí
  });

  it('un contacto de otra empresa es 404 para todos (A↔B), también el historial; cada empresa ve solo lo suyo', async () => {
    const inA = await newContact(T.alice, 'Ana A', '+593984217730');
    const inB = await newContact(T.bob, 'Beto B', '+593984217740');
    expect((await enroll(T.alice, inB)).status).toBe(404);
    expect((await enroll(T.bob, inA)).status).toBe(404);
    expect((await call('GET', `/ghl/contacts/${inB}/workflows`, T.alice)).status).toBe(404);
    expect((await enroll(T.alice, inA)).status).toBe(201);
    expect((await enroll(T.bob, inB)).status).toBe(201);
    expect((await history(T.bob, inB)).items).toHaveLength(1);
    expect((await rows(ORG_A)).map((r) => r['contact_id'])).toEqual([inA]);
    expect((await rows(ORG_B)).map((r) => r['contact_id'])).toEqual([inB]);
    // cada llamada usó las credenciales de SU empresa
    expect(calls('enrollInWorkflow').map((c) => (c as { credentials: { locationId: string } }).credentials.locationId)).toEqual([LOC_A, LOC_B]);
  });

  it('sin sesión 401; el permiso es solo del administrador y del asesor (no del acceso de solo lectura)', async () => {
    const id = await newContact(T.alice, 'Ana Torres', '+593984217730');
    expect((await call('POST', `/ghl/contacts/${id}/workflows`, undefined, { workflow_id: WF })).status).toBe(401);
    expect((await call('GET', `/ghl/contacts/${id}/workflows`)).status).toBe(401);
    // el permiso existe para administrador y asesor; el rol de agencia con nivel «lectura» no lo tiene (no está en el techo de solo lectura)
    const perms = (await admin.query(`SELECT role_key FROM role_permissions WHERE permission_key = 'ghl.enroll' ORDER BY role_key`)).rows.map((r) => r.role_key);
    expect(perms).toEqual(['advisor', 'client_admin']);
  });

  it('ghl_enrollments es de negocio: solo app_rw y de solo inserción; las restricciones impiden filas incoherentes', async () => {
    const as = async (url: string, sql: string) => {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        return await c.query(sql);
      } finally {
        await c.end();
      }
    };
    await expect(as(info.rwUrl, 'DELETE FROM ghl_enrollments')).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, `UPDATE ghl_enrollments SET status = 'done'`)).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, 'TRUNCATE ghl_enrollments')).rejects.toThrow(/permission denied/);
    for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, 'SELECT 1 FROM ghl_enrollments')).rejects.toThrow(/permission denied/);
    const id = await newContact(T.alice, 'X');
    const ins = (cols: string, vals: string) => admin.query(`INSERT INTO ghl_enrollments(id, organization_id, contact_id, ${cols}) VALUES (gen_random_uuid(), '${ORG_A}', '${id}', ${vals})`);
    await expect(ins('workflow_id, workflow_name, status', `'wf1', 'Flujo', 'raro'`)).rejects.toThrow(/ghl_enrollments_status_valid/);
    await expect(ins('workflow_id, workflow_name, status', `'', 'Flujo', 'done'`)).rejects.toThrow(/ghl_enrollments_workflow_shape/);
    await expect(ins('workflow_id, workflow_name, status', `'wf1', '  ', 'done'`)).rejects.toThrow(/ghl_enrollments_workflow_shape/);
    const other = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), '${ORG_B}', 'B') RETURNING id`)).rows[0].id as string;
    await expect(admin.query(`INSERT INTO ghl_enrollments(id, organization_id, contact_id, workflow_id, workflow_name, status) VALUES (gen_random_uuid(), '${ORG_A}', '${other}', 'wf1', 'Flujo', 'done')`)).rejects.toThrow(/ghl_enrollments_contact_fk/);
  });
});
