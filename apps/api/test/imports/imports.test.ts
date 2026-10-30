// M3.5 — Importar y exportar contactos en CSV (ADR-47). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   POST /v1/contacts/export · GET|POST /v1/contact-imports · GET|PATCH /v1/contact-imports/:id · POST /v1/contact-imports/:id/rows
//   GET /v1/contact-imports/:id/preview · POST /v1/contact-imports/:id/start · POST /v1/contact-imports/:id/process · POST /v1/contact-imports/:id/cancel · GET /v1/contact-imports/:id/report
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { ContactsModule } from '../../src/modules/contacts';
import { CustomFieldsModule } from '../../src/modules/custom-fields';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, ContactsModule, CustomFieldsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia (AG1), con acceso a A
  root: 'f0000000-0000-4000-8000-0000000000f1',
};

interface Imp { id: string; status: string; total_rows: number; staged_rows: number; options: Record<string, unknown>; counts: { created: number; updated: number; skipped: number; rejected: number; pending: number }; legal_basis_at: string | null; finished_at: string | null }
interface Preview { total: number; new: number; duplicates_existing: number; duplicates_in_file: number; invalid: number; samples: Array<{ row_no: number; reasons: string[] }> }
interface Err { error: { code: string; message: string; details: Array<{ path: string; code: string; message: string }> } }
interface Contact { id: string; name: string; email: string | null; phones: Array<{ e164: string }>; source: string; consent: string; owner: { id: string } | null; tags: Array<{ name: string }>; custom_fields: Record<string, unknown> }

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE contact_import_rows, contact_imports, contact_list_members, contact_lists, contact_tags, tags, meta_events, custom_field_values, custom_field_definitions, contact_phones, contacts, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@agencia1.test', null], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string, string | null]> = [[IDS.alice, ORG_A, 'client_admin', null], [IDS.carol, ORG_A, 'advisor', null], [IDS.bob, ORG_B, 'client_admin', null], [IDS.dave, AG1, 'agency', 'admin'], [IDS.dave, ORG_A, 'agency', 'admin'], [IDS.root, IDS.platformOrg, 'super_admin', null]];
  for (const [u, o, r, lv] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role,access_level) VALUES (gen_random_uuid(),$1,$2,$3,$4)`, [u, o, r, lv]);
}

const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
  expect(r.status, `login ${email}`).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
let T: Record<'alice' | 'carol' | 'bob' | 'dave' | 'root', string>;
const code = async (r: Response): Promise<string> => (await json<Err>(r)).error.code;
const newHash = (): string => createHash('sha256').update(randomBytes(16)).digest('hex');

const HEADERS = ['Nombre', 'Celular', 'Correo', 'Ciudad', 'Notas'];
const MAPPING = ['name', 'phone', 'email', 'ignore', 'ignore'];
const CF_MAPPING = ['name', 'phone', 'email', 'cf:ciudad', 'ignore'];

/** Crea la importación y sube todas las filas por lotes de `size`. Devuelve la importación lista (o la respuesta de error del paso que falló). */
async function prepare(t: string, rows: string[][], over: { mapping?: string[]; headers?: string[]; options?: Record<string, unknown>; hash?: string; size?: number } = {}): Promise<Imp> {
  const r = await call('POST', '/contact-imports', t, { file_name: 'clientes.csv', file_hash: over.hash ?? newHash(), total_rows: rows.length, headers: over.headers ?? HEADERS, mapping: over.mapping ?? MAPPING, options: over.options ?? {} });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  const imp = await json<Imp>(r);
  const size = over.size ?? 2;
  let last = imp;
  for (let i = 0; i < rows.length; i += size) {
    const s = await call('POST', `/contact-imports/${imp.id}/rows`, t, { from: i + 1, rows: rows.slice(i, i + size) });
    expect(s.status).toBe(200);
    last = await json<Imp>(s);
  }
  return last;
}
/** Empieza y procesa hasta terminar. */
async function run(t: string, id: string, start: Record<string, unknown> = {}): Promise<Imp> {
  const s = await call('POST', `/contact-imports/${id}/start`, t, start);
  expect(s.status, JSON.stringify(await s.clone().json())).toBe(200);
  let imp = await json<Imp>(s);
  for (let i = 0; i < 50 && imp.status !== 'done'; i++) imp = await json<Imp>(await call('POST', `/contact-imports/${id}/process`, t));
  expect(imp.status).toBe('done');
  return imp;
}
const preview = async (t: string, id: string): Promise<Preview> => json<Preview>(await call('GET', `/contact-imports/${id}/preview`, t));
const allContacts = async (t: string): Promise<Contact[]> => (await json<{ items: Contact[] }>(await call('GET', '/contacts?limit=100&sort=name&order=asc', t))).items;
const mkField = async (t: string, body: Record<string, unknown>) => expect((await call('POST', '/custom-fields', t, body)).status).toBe(201);
const mkTag = async (t: string, name: string): Promise<string> => (await json<{ id: string }>(await call('POST', '/tags', t, { name }))).id;
const audits = async (entityType: string, entityId?: string) =>
  (await admin.query(`SELECT field, new_value, source FROM audit_logs WHERE entity_type = $1 ${entityId ? 'AND entity_id = $2' : ''} ORDER BY at, id`, entityId ? [entityType, entityId] : [entityType])).rows as Array<{ field: string | null; new_value: Record<string, unknown>; source: string }>;
const mkContact = async (t: string, body: Record<string, unknown>): Promise<Contact> => {
  const r = await call('POST', '/contacts', t, body);
  expect(r.status, JSON.stringify(body)).toBe(201);
  return json<Contact>(r);
};
const raw = async (r: Response): Promise<string> => Buffer.from(await r.arrayBuffer()).toString('utf8');
const lines = (csv: string): string[] => csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), dave: await login('dave@agencia1.test'), root: await login('root@plat.test') };
});

describe('permisos', () => {
  it('sin sesión 401 y la plataforma 403 en todas las rutas; el asesor no importa ni exporta', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/contact-imports'], ['POST', '/contact-imports', {}], ['GET', `/contact-imports/${id}`], ['PATCH', `/contact-imports/${id}`, { options: { consent: 'unknown' } }], ['POST', `/contact-imports/${id}/rows`, { from: 1, rows: [['a']] }],
      ['GET', `/contact-imports/${id}/preview`], ['POST', `/contact-imports/${id}/start`, {}], ['POST', `/contact-imports/${id}/process`], ['POST', `/contact-imports/${id}/cancel`], ['GET', `/contact-imports/${id}/report`], ['POST', '/contacts/export', { scope: 'all' }],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, T.root, b)).status, `${m} ${p} plataforma`).toBe(403);
      expect((await call(m, p, T.carol, b)).status, `${m} ${p} asesor`).toBe(403);
    }
  });

  it('una agencia en el cliente con nivel administrador puede; con nivel lectura no (sacar datos no es una lectura inocua)', async () => {
    expect((await call('POST', '/context/switch', T.dave, { target: ORG_A })).status).toBe(200);
    expect((await call('POST', '/contacts/export', T.dave, { scope: 'all' })).status).toBe(200);
    await admin.query(`UPDATE organization_members SET access_level = 'read' WHERE user_id = $1 AND organization_id = $2`, [IDS.dave, ORG_A]);
    expect((await call('POST', '/contacts/export', T.dave, { scope: 'all' })).status).toBe(403);
    expect((await call('GET', '/contact-imports', T.dave)).status).toBe(403);
  });

  it('el listado de contactos informa si la persona puede importar y exportar (ayuda para la interfaz)', async () => {
    const access = async (t: string) => (await json<{ access: Record<string, boolean> }>(await call('GET', '/contacts', t))).access;
    expect(await access(T.alice)).toMatchObject({ import: true, export: true });
    expect(await access(T.carol)).toMatchObject({ import: false, export: false });
  });
});

describe('importación: preparar, revisar y confirmar', () => {
  it('valida el alta: teléfono obligatorio y único, un destino por columna, campos que existen, huella, tamaño y opciones', async () => {
    await mkField(T.alice, { name: 'Ciudad', type: 'text' });
    const body = (over: Record<string, unknown> = {}) => ({ file_name: 'a.csv', file_hash: newHash(), total_rows: 2, headers: HEADERS, mapping: MAPPING, options: {}, ...over });
    const bad = async (over: Record<string, unknown>, label: string) => expect((await call('POST', '/contact-imports', T.alice, body(over))).status, label).toBe(400);
    await bad({ mapping: ['name', 'ignore', 'email', 'cf:ciudad', 'ignore'] }, 'sin teléfono');
    await bad({ mapping: ['name', 'phone', 'phone', 'ignore', 'ignore'] }, 'dos teléfonos');
    await bad({ mapping: ['name', 'phone', 'name', 'ignore', 'ignore'] }, 'destino repetido');
    await bad({ mapping: ['name', 'phone'] }, 'faltan destinos');
    await bad({ mapping: ['name', 'phone', 'email', 'cf:fantasma', 'ignore'] }, 'campo inexistente');
    await bad({ mapping: ['name', 'phone', 'email', 'cf:Mayus', 'ignore'] }, 'destino mal escrito');
    await bad({ file_hash: 'abc' }, 'huella corta');
    await bad({ total_rows: 0 }, 'sin filas');
    await bad({ total_rows: 5001 }, 'demasiadas filas');
    await bad({ options: { country_prefix: '593' } }, 'prefijo sin +');
    await bad({ options: { duplicates: 'create' } }, 'política que no existe');
    await bad({ options: { consent: 'revoked' } }, 'consentimiento no permitido');
    await bad({ options: { tag_id: '11111111-1111-4111-8111-111111111111' } }, 'etiqueta inexistente');
    await bad({ options: { owner_id: IDS.bob } }, 'responsable de otra empresa');
    await bad({ options: { extra: 1 } }, 'opción desconocida');
    const sys = (await json<{ items: Array<{ id: string; system_key: string | null }> }>(await call('GET', '/tags', T.alice))).items.find((t) => t.system_key === 'lead')!;
    await bad({ options: { tag_id: sys.id } }, 'etiqueta del sistema');
    const ok = await call('POST', '/contact-imports', T.alice, body({ options: { owner_id: IDS.carol } }));
    expect(ok.status).toBe(201);
    expect(await json<Imp>(ok)).toMatchObject({ status: 'staging', staged_rows: 0, options: { duplicates: 'skip', country_prefix: '+593', consent: 'unknown', tag_id: null, owner_id: IDS.carol } });
  });

  it('las filas se suben en orden y por lotes; repetir un lote no duplica; los huecos, el exceso y las columnas de menos se rechazan', async () => {
    const rows = [['A', '0984217730', '', '', ''], ['B', '0991112233', '', '', ''], ['C', '0987654321', '', '', '']];
    const r = await call('POST', '/contact-imports', T.alice, { file_name: 'a.csv', file_hash: newHash(), total_rows: 3, headers: HEADERS, mapping: MAPPING, options: {} });
    const id = (await json<Imp>(r)).id;
    const send = (from: number, rs: string[][]) => call('POST', `/contact-imports/${id}/rows`, T.alice, { from, rows: rs });
    const gap = await send(3, [rows[2]!]);
    expect(gap.status).toBe(409);
    expect(await code(gap)).toBe('IMPORT_ROW_OUT_OF_ORDER');
    expect((await send(1, [['solo', 'dos columnas']])).status).toBe(400);
    expect(await json<Imp>(await send(1, rows.slice(0, 2)))).toMatchObject({ staged_rows: 2, status: 'staging' });
    expect(await json<Imp>(await send(1, rows.slice(0, 2)))).toMatchObject({ staged_rows: 2 }); // reintento tras un corte de red: no duplica
    expect(await json<Imp>(await send(2, rows.slice(1, 3)))).toMatchObject({ staged_rows: 3, status: 'ready' }); // solape: entra solo lo nuevo
    expect((await admin.query('SELECT count(*)::int AS n FROM contact_import_rows')).rows[0].n).toBe(3);
    const late = await send(4, [rows[0]!]);
    expect([400, 409]).toContain(late.status);
    expect(await code(await send(3, [rows[2]!]))).toBe('IMPORT_NOT_STAGING');
    expect((await call('POST', `/contact-imports/${id}/rows`, T.alice, { from: 1, rows: [] })).status).toBe(400);
  });

  it('la vista previa cuenta nuevos, duplicados (contra la empresa y dentro del archivo) e inválidas con su motivo, con las mismas reglas del proceso', async () => {
    await mkField(T.alice, { name: 'Ciudad', type: 'text' });
    await mkContact(T.alice, { name: 'Ya existía', phones: ['+593984217730'] });
    const rows = [
      ['Ana', '0991112233', 'ana@correo.test', 'Quito', ''],
      ['Beto', '098 421 7730', '', '', ''], // ya existe
      ['Carla', '0991112233', '', '', ''], // repetido dentro del archivo
      ['Dani', '', '', '', ''], // sin teléfono
      ['Eva', '123', '', '', ''], // teléfono inválido
      ['Fer', '0987654321', 'malo', '', ''], // correo inválido
      ['Gus', '+34 612 345 678', '', '', ''],
    ];
    const imp = await prepare(T.alice, rows, { mapping: CF_MAPPING });
    expect(imp).toMatchObject({ status: 'ready', staged_rows: 7 });
    const p = await preview(T.alice, imp.id);
    expect(p).toMatchObject({ total: 7, new: 2, duplicates_existing: 1, duplicates_in_file: 1, invalid: 3 });
    expect(p.samples).toEqual([{ row_no: 4, reasons: ['Falta el teléfono'] }, { row_no: 5, reasons: ['Teléfono no válido'] }, { row_no: 6, reasons: ['Correo no válido'] }]);
    // otro prefijo de país cambia lo que se entiende como nuevo
    await call('PATCH', `/contact-imports/${imp.id}`, T.alice, { options: { country_prefix: '+57' } });
    expect((await preview(T.alice, imp.id)).duplicates_existing).toBe(0);
    expect((await call('GET', `/contact-imports/${imp.id}/preview`, T.alice)).status).toBe(200);
    const earlyId = (await json<Imp>(await call('POST', '/contact-imports', T.alice, { file_name: 'x.csv', file_hash: newHash(), total_rows: 2, headers: HEADERS, mapping: MAPPING, options: {} }))).id;
    expect(await code(await call('GET', `/contact-imports/${earlyId}/preview`, T.alice))).toBe('IMPORT_NOT_READY');
    expect(await code(await call('POST', `/contact-imports/${earlyId}/start`, T.alice, {}))).toBe('IMPORT_NOT_READY');
  });

  it('valida los valores de campos personalizados con las reglas de su tipo (una fila con un valor inválido se rechaza con el motivo); los obligatorios no se exigen', async () => {
    await mkField(T.alice, { name: 'Edad', type: 'number' });
    await mkField(T.alice, { name: 'Interés', type: 'select', options: ['Uñas', 'Barbería'] });
    await mkField(T.alice, { name: 'Cédula', type: 'text', required: true });
    const imp = await prepare(T.alice, [['Ana', '0991112233', '1,5', 'Uñas'], ['Beto', '0987654321', 'abc', 'Uñas'], ['Carla', '0985555555', '40', 'Pintura'], ['Dani', '0984444444', '', '']], { headers: ['Nombre', 'Celular', 'Edad', 'Interés'], mapping: ['name', 'phone', 'cf:edad', 'cf:interes'] });
    const p = await preview(T.alice, imp.id);
    expect(p).toMatchObject({ new: 2, invalid: 2 });
    expect(p.samples.map((s) => s.reasons[0])).toEqual([expect.stringMatching(/Edad/), expect.stringMatching(/Interés/)]);
    const done = await run(T.alice, imp.id);
    expect(done.counts).toMatchObject({ created: 2, rejected: 2 });
    const byName = Object.fromEntries((await allContacts(T.alice)).map((c) => [c.name, c]));
    expect(byName['Ana']!.custom_fields).toEqual({ edad: 1.5, interes: 'Uñas' });
    expect(byName['Dani']!.custom_fields).toEqual({}); // la Cédula obligatoria no se exigió
  });
});

describe('importación: proceso', () => {
  it('flujo completo: crea con origen import, consentimiento sin definir, etiqueta, responsable y campos; omite duplicados; rechaza lo inválido; el reporte trae esas filas con su motivo', async () => {
    await mkField(T.alice, { name: 'Ciudad', type: 'text' });
    const tag = await mkTag(T.alice, 'Importados');
    await mkContact(T.alice, { name: 'Ya existía', phones: ['+593984217730'], email: 'viejo@correo.test' });
    const rows = [
      ['Ana Torres', '0991112233', 'ANA@Correo.TEST', 'Quito', 'x'],
      ['Beto', '098 421 7730', 'beto@correo.test', 'Cuenca', ''],
      ['Carla', '0991112233', '', '', ''],
      ['Dani', '', '', '', ''],
      ['Gus', '0987654321 | +34612345678', '', 'Lima', ''],
      ['', '0985555555', '', '', ''],
    ];
    const imp = await prepare(T.alice, rows, { options: { tag_id: tag, owner_id: IDS.carol }, mapping: CF_MAPPING });
    const done = await run(T.alice, imp.id);
    expect(done).toMatchObject({ status: 'done', counts: { created: 3, updated: 0, skipped: 2, rejected: 1, pending: 0 } });
    expect(done.finished_at).not.toBeNull();

    const list = await allContacts(T.alice);
    expect(list.map((c) => c.name)).toEqual(['', 'Ana Torres', 'Gus', 'Ya existía'].map((n) => (n === '' ? '+593985555555' : n)).sort((a, b) => a.localeCompare(b)));
    const ana = list.find((c) => c.name === 'Ana Torres')!;
    expect(ana).toMatchObject({ email: 'ana@correo.test', source: 'import', consent: 'unknown', owner: { id: IDS.carol }, custom_fields: { ciudad: 'Quito' } });
    expect(ana.tags.map((t) => t.name)).toEqual(['Importados']);
    expect(list.find((c) => c.name === 'Gus')!.phones.map((p) => p.e164)).toEqual(['+593987654321', '+34612345678']);
    expect(list.find((c) => c.name === 'Ya existía')!.email).toBe('viejo@correo.test'); // intacto
    // importar no genera eventos hacia Meta ni etiqueta Lead
    expect((await admin.query('SELECT count(*)::int AS n FROM meta_events')).rows[0].n).toBe(0);
    expect(list.flatMap((c) => c.tags.map((t) => t.name))).not.toContain('Lead');

    const report = await call('GET', `/contact-imports/${imp.id}/report`, T.alice);
    expect(report.headers.get('content-type')).toMatch(/text\/csv/);
    expect(report.headers.get('content-disposition')).toMatch(/attachment; filename="clientes-reporte\.csv"/);
    const csv = await raw(report);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(lines(csv)).toEqual([
      'Nombre,Celular,Correo,Ciudad,Notas,Estado,Motivo',
      'Beto,098 421 7730,beto@correo.test,Cuenca,,Omitida,Ya existe un contacto con ese teléfono',
      'Carla,0991112233,,,,Omitida,Ya existe un contacto con ese teléfono',
      'Dani,,,,,Rechazada,Falta el teléfono',
    ]);
    // minimización de datos: las filas ya importadas no conservan su contenido; las rechazadas y omitidas sí
    const rowsDb = (await admin.query(`SELECT status, data IS NULL AS vacia FROM contact_import_rows ORDER BY row_no`)).rows as Array<{ status: string; vacia: boolean }>;
    expect(rowsDb.map((r) => [r.status, r.vacia])).toEqual([['created', true], ['skipped', false], ['skipped', false], ['rejected', false], ['created', true], ['created', true]]);
  });

  it('«actualizar solo los campos vacíos» completa lo que falta, suma teléfonos y etiqueta, y nunca pisa un dato ni cambia el consentimiento', async () => {
    await mkField(T.alice, { name: 'Ciudad', type: 'text' });
    await mkField(T.alice, { name: 'Edad', type: 'number' });
    const tag = await mkTag(T.alice, 'Importados');
    const lleno = await mkContact(T.alice, { name: 'Con datos', phones: ['+593984217730'], email: 'dueno@correo.test', consent: 'granted', custom_fields: { ciudad: 'Quito' } });
    const solo = await mkContact(T.alice, { name: '+593991112233', phones: ['+593991112233'] }); // nombre provisional = teléfono
    const rows = [
      ['Nombre Nuevo', '0984217730 | 0987654321', 'otro@correo.test', 'Lima', '33'],
      ['Ya Con Nombre', '0991112233', 'solo@correo.test', 'Cuenca', ''],
      ['Nada Nuevo', '0984217730', 'dueno@correo.test', 'Quito', ''],
    ];
    const imp = await prepare(T.alice, rows, { options: { duplicates: 'update_empty', tag_id: tag, owner_id: IDS.carol }, headers: ['Nombre', 'Celular', 'Correo', 'Ciudad', 'Edad'], mapping: ['name', 'phone', 'email', 'cf:ciudad', 'cf:edad'] });
    const done = await run(T.alice, imp.id);
    expect(done.counts).toMatchObject({ created: 0, updated: 2, skipped: 1 });
    const a = (await allContacts(T.alice)).find((c) => c.id === lleno.id)!;
    expect(a).toMatchObject({ name: 'Con datos', email: 'dueno@correo.test', consent: 'granted', owner: { id: IDS.carol } });
    expect(a.custom_fields).toEqual({ ciudad: 'Quito', edad: 33 }); // la ciudad no se pisó; la edad estaba vacía
    expect(a.phones.map((p) => p.e164)).toEqual(['+593984217730', '+593987654321']); // el teléfono nuevo se suma
    expect(a.tags.map((t) => t.name)).toEqual(['Importados']);
    const b = (await allContacts(T.alice)).find((c) => c.id === solo.id)!;
    expect(b).toMatchObject({ name: 'Ya Con Nombre', email: 'solo@correo.test', custom_fields: { ciudad: 'Cuenca' } });
    expect(b.consent).toBe('unknown');
    const rep = lines(await (await call('GET', `/contact-imports/${imp.id}/report`, T.alice)).text());
    expect(rep[1]).toMatch(/Nada Nuevo.*Omitida,El contacto ya tenía esos datos/);
    expect((await audits('contact', lleno.id)).filter((x) => x.field === 'import')).toHaveLength(1);
  });

  it('con «omitir» (por defecto) un teléfono repetido en el archivo se omite en su segunda aparición; con teléfonos de contactos distintos se omite con el motivo', async () => {
    await mkContact(T.alice, { name: 'Uno', phones: ['+593984217730'] });
    await mkContact(T.alice, { name: 'Dos', phones: ['+593991112233'] });
    const imp = await prepare(T.alice, [['X', '0984217730 | 0991112233', '', '', ''], ['Y', '0987654321', '', '', ''], ['Z', '0987654321', '', '', '']]);
    const done = await run(T.alice, imp.id);
    expect(done.counts).toMatchObject({ created: 1, skipped: 2 });
    expect(lines(await (await call('GET', `/contact-imports/${imp.id}/report`, T.alice)).text()).slice(1).map((l) => l.split(',').at(-1))).toEqual(['Sus teléfonos pertenecen a contactos distintos', 'Ya existe un contacto con ese teléfono']);
  });

  it('el consentimiento «con consentimiento» exige confirmar la base legal (queda registrado con fecha); sin ella se rechaza y no se crea nada', async () => {
    const imp = await prepare(T.alice, [['Ana', '0991112233', '', '', '']], { options: { consent: 'granted' } });
    const no = await call('POST', `/contact-imports/${imp.id}/start`, T.alice, {});
    expect(no.status).toBe(400);
    expect((await json<Err>(no)).error.details[0]).toMatchObject({ path: 'legal_basis', code: 'required' });
    expect((await call('POST', `/contact-imports/${imp.id}/start`, T.alice, { legal_basis: false })).status).toBe(400);
    expect((await call('GET', `/contact-imports/${imp.id}`, T.alice).then((r) => json<Imp>(r))).status).toBe('ready');
    const done = await run(T.alice, imp.id, { legal_basis: true });
    expect(done.legal_basis_at).not.toBeNull();
    const c = (await allContacts(T.alice))[0]!;
    expect(c.consent).toBe('granted');
    expect((await admin.query('SELECT consent_updated_at FROM contacts WHERE id = $1', [c.id])).rows[0].consent_updated_at).not.toBeNull();
    expect((await audits('contact_import', imp.id)).find((a) => a.field === 'started')!.new_value).toMatchObject({ consent: 'granted', legal_basis: true, by: IDS.alice });
  });

  it('idempotencia: el mismo archivo no se importa dos veces (409 con la importación anterior) salvo que se haya cancelado; procesar de más no duplica', async () => {
    const h = newHash();
    const rows = [['Ana', '0991112233', '', '', ''], ['Beto', '0987654321', '', '', '']];
    const imp = await prepare(T.alice, rows, { hash: h });
    const dup = await call('POST', '/contact-imports', T.alice, { file_name: 'otra-copia.csv', file_hash: h, total_rows: 2, headers: HEADERS, mapping: MAPPING, options: {} });
    expect(dup.status).toBe(409);
    const e = (await json<Err>(dup)).error;
    expect(e.code).toBe('IMPORT_DUPLICATE_FILE');
    expect(e.details[0]).toMatchObject({ path: 'import_id', message: imp.id });
    await run(T.alice, imp.id);
    const again = await json<Imp>(await call('POST', `/contact-imports/${imp.id}/process`, T.alice));
    expect(again).toMatchObject({ status: 'done', counts: { created: 2 } });
    expect((await allContacts(T.alice)).length).toBe(2);
    expect((await call('POST', '/contact-imports', T.alice, { file_name: 'x.csv', file_hash: h, total_rows: 1, headers: HEADERS, mapping: MAPPING, options: {} })).status).toBe(409); // sigue vigente

    // cancelada: la huella queda libre
    const h2 = newHash();
    const imp2 = await prepare(T.alice, [['Carla', '0985555555', '', '', '']], { hash: h2 });
    const cancelled = await json<Imp>(await call('POST', `/contact-imports/${imp2.id}/cancel`, T.alice));
    expect(cancelled.status).toBe('cancelled');
    expect((await call('POST', '/contact-imports', T.alice, { file_name: 'x.csv', file_hash: h2, total_rows: 1, headers: HEADERS, mapping: MAPPING, options: {} })).status).toBe(201);
    expect(await code(await call('POST', `/contact-imports/${imp.id}/cancel`, T.alice))).toBe('IMPORT_LOCKED'); // una terminada no se cancela
  });

  it('dos personas procesando a la vez no duplican contactos (candado de la importación) y el proceso se puede reanudar lote a lote', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => [`Contacto ${i}`, `09${String(10000000 + i)}`, '', '', '']);
    const imp = await prepare(T.alice, rows, { size: 150 });
    expect((await call('POST', `/contact-imports/${imp.id}/start`, T.alice, {})).status).toBe(200);
    const first = await json<Imp>(await call('POST', `/contact-imports/${imp.id}/process`, T.alice));
    expect(first).toMatchObject({ status: 'running', counts: { created: 200, pending: 250 } }); // un lote de 200
    const rest = await Promise.all([call('POST', `/contact-imports/${imp.id}/process`, T.alice), call('POST', `/contact-imports/${imp.id}/process`, T.alice), call('POST', `/contact-imports/${imp.id}/process`, T.alice)]);
    expect(rest.every((r) => r.status === 200)).toBe(true);
    let cur = await json<Imp>(await call('GET', `/contact-imports/${imp.id}`, T.alice));
    for (let i = 0; i < 5 && cur.status !== 'done'; i++) cur = await json<Imp>(await call('POST', `/contact-imports/${imp.id}/process`, T.alice));
    expect(cur).toMatchObject({ status: 'done', counts: { created: 450, pending: 0 } });
    expect((await admin.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(450);
    expect((await admin.query('SELECT count(DISTINCT e164)::int AS n FROM contact_phones')).rows[0].n).toBe(450);
  }, 60_000);

  it('las opciones solo se cambian antes de empezar; una importación en marcha no se cancela ni acepta más filas', async () => {
    const imp = await prepare(T.alice, [['Ana', '0991112233', '', '', '']]);
    expect((await call('PATCH', `/contact-imports/${imp.id}`, T.alice, { options: { duplicates: 'update_empty' } })).status).toBe(200);
    expect((await call('PATCH', `/contact-imports/${imp.id}`, T.alice, { options: {} })).status).toBe(400);
    expect((await call('PATCH', `/contact-imports/${imp.id}`, T.alice, { options: { tag_id: '11111111-1111-4111-8111-111111111111' } })).status).toBe(400);
    await call('POST', `/contact-imports/${imp.id}/start`, T.alice, {});
    expect(await code(await call('PATCH', `/contact-imports/${imp.id}`, T.alice, { options: { duplicates: 'skip' } }))).toBe('IMPORT_LOCKED');
    expect(await code(await call('POST', `/contact-imports/${imp.id}/cancel`, T.alice))).toBe('IMPORT_LOCKED');
    expect(await code(await call('POST', `/contact-imports/${imp.id}/start`, T.alice, {}))).toBe('IMPORT_NOT_READY');
    const notStarted = await prepare(T.alice, [['Beto', '0987654321', '', '', '']]);
    expect(await code(await call('POST', `/contact-imports/${notStarted.id}/process`, T.alice))).toBe('IMPORT_NOT_RUNNING');
  });

  it('el historial lista las importaciones recientes con sus resultados; todo queda en la auditoría', async () => {
    const imp = await prepare(T.alice, [['Ana', '0991112233', '', '', ''], ['', '', '', '', '']]);
    await run(T.alice, imp.id);
    const hist = await json<{ items: Imp[] }>(await call('GET', '/contact-imports', T.alice));
    expect(hist.items).toHaveLength(1);
    expect(hist.items[0]).toMatchObject({ id: imp.id, status: 'done', counts: { created: 1, rejected: 1 } });
    const audit = await audits('contact_import', imp.id);
    expect(audit.map((a) => a.field)).toEqual(['started', 'finished']);
    expect(audit[1]!.new_value).toEqual({ created: 1, updated: 0, skipped: 0, rejected: 1 });
    const created = (await audits('contact')).find((a) => a.field === null)!;
    expect(created.new_value).toMatchObject({ source: 'import', import_id: imp.id, phones: ['+593991112233'] });
    expect(created.source).toBe('manual');
  });
});

describe('aislamiento A↔B', () => {
  it('B no ve, cambia, procesa ni descarga la importación de A (404); el mismo archivo se puede importar en B; los teléfonos se comparan por empresa', async () => {
    const h = newHash();
    const rows = [['Ana', '0991112233', '', '', '']];
    const a = await prepare(T.alice, rows, { hash: h });
    expect((await json<{ items: unknown[] }>(await call('GET', '/contact-imports', T.bob))).items).toEqual([]);
    for (const [m, p, body] of [['GET', `/contact-imports/${a.id}`], ['PATCH', `/contact-imports/${a.id}`, { options: { consent: 'unknown' } }], ['POST', `/contact-imports/${a.id}/rows`, { from: 2, rows: [['x', '1', '', '', '']] }], ['GET', `/contact-imports/${a.id}/preview`], ['POST', `/contact-imports/${a.id}/start`, {}], ['POST', `/contact-imports/${a.id}/process`], ['POST', `/contact-imports/${a.id}/cancel`], ['GET', `/contact-imports/${a.id}/report`]] as const) {
      expect((await call(m, p, T.bob, body)).status, `B ${m} ${p}`).toBe(404);
    }
    await run(T.alice, a.id);
    const b = await prepare(T.bob, rows, { hash: h }); // mismo archivo, otra empresa
    expect((await preview(T.bob, b.id)).new).toBe(1); // el teléfono de A no cuenta como duplicado en B
    await run(T.bob, b.id);
    expect((await admin.query('SELECT organization_id, count(*)::int AS n FROM contacts GROUP BY 1 ORDER BY 1')).rows).toHaveLength(2);
    // la etiqueta o el responsable de A no sirven en B
    const tagA = await mkTag(T.alice, 'De A');
    const r = await call('POST', '/contact-imports', T.bob, { file_name: 'x.csv', file_hash: newHash(), total_rows: 1, headers: HEADERS, mapping: MAPPING, options: { tag_id: tagA } });
    expect(r.status).toBe(400);
  });
});

describe('exportar', () => {
  async function world() {
    await mkField(T.alice, { name: 'Ciudad', type: 'text' });
    await mkField(T.alice, { name: 'Vip', type: 'boolean' });
    await mkField(T.alice, { name: 'Horarios', type: 'multiselect', options: ['Mañana', 'Tarde'] });
    const tag = await mkTag(T.alice, 'VIP');
    const ana = await mkContact(T.alice, { name: 'Ana Torres', email: 'ana@correo.test', phones: ['+593984217730', '+34612345678'], consent: 'granted', owner_id: IDS.carol, tag_ids: [tag], custom_fields: { ciudad: 'Quito', vip: true, horarios: ['Mañana', 'Tarde'] } });
    const beto = await mkContact(T.alice, { name: 'Beto, "el Jefe"', phones: ['+593991112233'], custom_fields: { ciudad: 'Cuenca' } });
    const evil = await mkContact(T.alice, { name: '=HYPERLINK("http://malo.test","clic")', phones: ['+593987654321'] });
    return { ana, beto, evil, tag };
  }
  const exp = (t: string, body: Record<string, unknown>) => call('POST', '/contacts/export', t, body);

  it('exporta todo con todas las columnas: cabeceras en español, BOM, teléfonos y etiquetas unidos con « | », campos personalizados legibles, y cabecera con el total', async () => {
    await world();
    const r = await exp(T.alice, { scope: 'all', sort: 'name', order: 'asc' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/csv; charset=utf-8/);
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="contactos-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(r.headers.get('x-export-count')).toBe('3');
    const csv = await raw(r);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const ls = lines(csv);
    expect(ls[0]).toBe('Nombre,Teléfono,Correo,Empresa,Responsable,Origen,Consentimiento,Etiquetas,Último anuncio,Creado,Actualizado,Ciudad,Vip,Horarios');
    expect(ls).toHaveLength(4);
    const ana = ls.find((l) => l.startsWith('Ana Torres'))!;
    expect(ana).toContain('+593984217730 | +34612345678'.replace('+593984217730', "'+593984217730")); // el texto que empieza por + se neutraliza
    expect(ana).toContain('Carolina Vera');
    expect(ana).toContain('Con consentimiento');
    expect(ana).toContain(',VIP,');
    expect(ana.endsWith(',Quito,Sí,Mañana | Tarde')).toBe(true);
    expect(ls.find((l) => l.includes('el Jefe'))).toMatch(/^"Beto, ""el Jefe"""/); // comillas y coma escapadas
  });

  it('protege contra la inyección de fórmulas: un nombre que empieza por = sale con comilla simple delante', async () => {
    await world();
    const csv = await (await exp(T.alice, { scope: 'all', columns: ['name'] })).text();
    expect(lines(csv)).toContain(`"'=HYPERLINK(""http://malo.test"",""clic"")"`);
    expect(csv).not.toMatch(/(^|\r\n)=HYPERLINK/);
  });

  it('elige las columnas (en el orden del catálogo); una columna de un campo que no existe se ignora', async () => {
    await world();
    const csv = await (await exp(T.alice, { scope: 'all', columns: ['cf:ciudad', 'name', 'cf:fantasma'], sort: 'name', order: 'asc' })).text();
    expect(lines(csv)[0]).toBe('Nombre,Ciudad');
    expect(lines(csv)).toContain('Ana Torres,Quito');
    expect((await exp(T.alice, { scope: 'all', columns: ['secreto'] })).status).toBe(400);
    expect((await exp(T.alice, { scope: 'all', columns: ['name', 'name'] })).status).toBe(400);
  });

  it('«vista»: aplica los mismos filtros que el listado (búsqueda, etiquetas, campos personalizados, lista abierta); «todos» los ignora', async () => {
    const w = await world();
    const names = async (body: Record<string, unknown>) => lines(await (await exp(T.alice, { columns: ['name'], sort: 'name', order: 'asc', ...body })).text()).slice(1);
    expect(await names({ scope: 'view', q: 'ana' })).toEqual(['Ana Torres']);
    expect(await names({ scope: 'view', tag: [w.tag] })).toEqual(['Ana Torres']);
    expect(await names({ scope: 'view', consent: 'granted' })).toEqual(['Ana Torres']);
    expect(await names({ scope: 'view', cf: ['ciudad:eq:Cuenca'] })).toEqual(['"Beto, ""el Jefe"""']);
    expect(await names({ scope: 'all', q: 'ana' })).toHaveLength(3);
    const list = await json<{ id: string }>(await call('POST', '/contact-lists', T.alice, { name: 'Fija', kind: 'fixed', contact_ids: [w.beto.id] }));
    expect(await names({ scope: 'view', list: list.id })).toEqual(['"Beto, ""el Jefe"""']);
    expect((await exp(T.alice, { scope: 'view', cf: ['fantasma:eq:x'] })).status).toBe(400);
    expect((await exp(T.alice, { scope: 'view', list: '11111111-1111-4111-8111-111111111111' })).status).toBe(404);
  });

  it('«selección»: solo los ids pedidos que la persona puede ver; los de otra empresa no salen; sin ids es un 400', async () => {
    const w = await world();
    const other = await mkContact(T.bob, { name: 'Ajeno de B', phones: ['+593984217730'] });
    const r = await exp(T.alice, { scope: 'selection', ids: [w.ana.id, other.id], columns: ['name'] });
    expect(lines(await r.text())).toEqual(['Nombre', 'Ana Torres']);
    expect(r.headers.get('x-export-count')).toBe('1');
    expect((await exp(T.alice, { scope: 'selection', columns: ['name'] })).status).toBe(400);
    expect((await exp(T.alice, { scope: 'selection', ids: [], columns: ['name'] })).status).toBe(400);
    expect((await exp(T.alice, { scope: 'selection', ids: ['no-uuid'] })).status).toBe(400);
    expect(lines(await (await exp(T.alice, { scope: 'selection', ids: [other.id], columns: ['name'] })).text())).toEqual(['Nombre']);
  });

  it('cada exportación queda auditada con quién, cuántos, qué columnas y qué filtros', async () => {
    const w = await world();
    await exp(T.alice, { scope: 'view', q: 'ana', consent: 'granted', columns: ['name', 'phone'] });
    await exp(T.alice, { scope: 'selection', ids: [w.ana.id, w.beto.id], columns: ['name'] });
    const rows = await audits('contact_export');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.new_value).toMatchObject({ scope: 'view', count: 1, columns: ['name', 'phone'], by: IDS.alice, filters: { q: 'ana', consent: 'granted', tag: [], cf: [], list: null } });
    expect(rows[1]!.new_value).toMatchObject({ scope: 'selection', count: 2, selected: 2, columns: ['name'] });
    expect(JSON.stringify(rows)).not.toContain('Ana Torres'); // la auditoría no guarda datos personales de lo exportado
  });

  it('aislamiento A↔B: B solo exporta lo suyo', async () => {
    await world();
    await mkContact(T.bob, { name: 'Beto de B', phones: ['+593984217730'] });
    expect(lines(await (await exp(T.bob, { scope: 'all', columns: ['name'] })).text())).toEqual(['Nombre', 'Beto de B']);
    expect(lines(await (await exp(T.alice, { scope: 'all', columns: ['name'] })).text())).toHaveLength(4);
  });

  it('un archivo exportado se vuelve a importar tal cual (los teléfonos neutralizados se leen bien) y reconstruye los mismos contactos en otra empresa', async () => {
    await world();
    const csv = (await (await exp(T.alice, { scope: 'all', columns: ['name', 'phone', 'email'], sort: 'name', order: 'asc' })).text()).replace(/^\uFEFF/, '');
    // lectura mínima del CSV exportado (las celdas con comillas se manejan en el navegador; aquí solo hay celdas simples salvo el nombre con coma)
    const rows = csv.split('\r\n').filter(Boolean).slice(1).map((l) => (l.startsWith('"') ? ['Beto, "el Jefe"', ...l.slice(l.lastIndexOf('"') + 2).split(',')] : l.split(',')));
    const imp = await prepare(T.bob, rows, { headers: ['Nombre', 'Teléfono', 'Correo'], mapping: ['name', 'phone', 'email'] });
    const done = await run(T.bob, imp.id);
    expect(done.counts).toMatchObject({ created: 3, rejected: 0 });
    const phones = (await allContacts(T.bob)).flatMap((c) => c.phones.map((p) => p.e164)).sort();
    expect(phones).toEqual(['+34612345678', '+593984217730', '+593987654321', '+593991112233']);
  });
});

describe('base de datos: privilegios y restricciones', () => {
  const as = async (url: string, sql: string) => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      return await c.query(sql);
    } finally {
      await c.end();
    }
  };

  it('app_rw no puede borrar ni vaciar; platform e identity no ven las tablas', async () => {
    for (const t of ['contact_imports', 'contact_import_rows']) {
      await expect(as(info.rwUrl, `DELETE FROM ${t}`), `DELETE ${t}`).rejects.toThrow(/permission denied/);
      await expect(as(info.rwUrl, `TRUNCATE ${t}`), `TRUNCATE ${t}`).rejects.toThrow(/permission denied/);
      for (const url of [info.platformUrl, info.identityUrl]) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    }
  });

  it('las restricciones protegen la forma de los datos y las claves foráneas impiden cruzar empresas', async () => {
    const a = await prepare(T.alice, [['Ana', '0991112233', '', '', '']]);
    const bad = (sql: string) => admin.query(sql);
    const ins = (cols: string, vals: string) => `INSERT INTO contact_imports(organization_id, id, created_by, headers, mapping, options, ${cols}) VALUES ('${ORG_A}', gen_random_uuid(), '${IDS.alice}', '["a"]', '["phone"]', '{}', ${vals})`;
    await expect(bad(ins('file_name, file_hash, total_rows', `'x', 'zz', 1`))).rejects.toThrow(/contact_imports_hash_hex/);
    await expect(bad(ins('file_name, file_hash, total_rows', `'x', '${newHash()}', 0`))).rejects.toThrow(/contact_imports_rows_valid/);
    await expect(bad(ins('file_name, file_hash, total_rows', `'x', '${newHash()}', 5001`))).rejects.toThrow(/contact_imports_rows_valid/);
    await expect(bad(ins('file_name, file_hash, total_rows, status', `'x', '${newHash()}', 1, 'rara'`))).rejects.toThrow(/contact_imports_status_valid/);
    await expect(bad(ins('file_name, file_hash, total_rows', `'  ', '${newHash()}', 1`))).rejects.toThrow(/contact_imports_name_shape/);
    await expect(bad(`INSERT INTO contact_imports(organization_id, id, created_by, headers, mapping, options, file_name, file_hash, total_rows) VALUES ('${ORG_A}', gen_random_uuid(), '${IDS.alice}', '["a","b"]', '["phone"]', '{}', 'x', '${newHash()}', 1)`)).rejects.toThrow(/contact_imports_arrays/);
    const hashA = (await admin.query('SELECT file_hash FROM contact_imports WHERE id = $1', [a.id])).rows[0].file_hash as string;
    await expect(bad(ins('file_name, file_hash, total_rows', `'otro', '${hashA}', 1`))).rejects.toThrow(/contact_imports_org_hash_uq/);
    await expect(bad(`INSERT INTO contact_import_rows(organization_id, import_id, row_no, data) VALUES ('${ORG_B}', '${a.id}', 9, '[]')`)).rejects.toThrow(/contact_import_rows_import_fk/);
    await expect(bad(`INSERT INTO contact_import_rows(organization_id, import_id, row_no, data, status) VALUES ('${ORG_A}', '${a.id}', 9, '[]', 'rara')`)).rejects.toThrow(/contact_import_rows_status_valid/);
    await expect(bad(`INSERT INTO contact_import_rows(organization_id, import_id, row_no, data) VALUES ('${ORG_A}', '${a.id}', 0, '[]')`)).rejects.toThrow(/contact_import_rows_no_valid/);
    await expect(bad(`INSERT INTO contact_import_rows(organization_id, import_id, row_no, data) VALUES ('${ORG_A}', '${a.id}', 1, '[]')`)).rejects.toThrow(/contact_import_rows_pk/);
  });

  it('la RLS: sin organización activa app_rw no ve importaciones; con la de A no ve las de B', async () => {
    await prepare(T.alice, [['Ana', '0991112233', '', '', '']]);
    await prepare(T.bob, [['Beto', '0991112233', '', '', '']]);
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      expect((await c.query('SELECT count(*)::int AS n FROM contact_imports')).rows[0].n).toBe(0);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      expect((await c.query('SELECT count(*)::int AS n FROM contact_imports')).rows[0].n).toBe(1);
      expect((await c.query('SELECT count(*)::int AS n FROM contact_import_rows')).rows[0].n).toBe(1);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });
});
