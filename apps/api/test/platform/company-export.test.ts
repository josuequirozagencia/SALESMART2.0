// F3b (ADR-59 #8/#9) — «Descargar todo» de una empresa eliminada. Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   GET /v1/platform/companies/:id/export
//   POST /v1/platform/companies/:id/export
//   POST /v1/platform/companies/:id/export/download
//   POST /v1/public/company-export/status
//   POST /v1/public/company-export/request
//   POST /v1/public/company-export/download
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uuidv7 } from '@sales-smart/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule, WindowLimiter } from '../../src/http';
import { AuthModule, CompanyExportStore, LocalAccessResolver } from '../../src/modules/auth';
import { MAIL_PROVIDER, MemoryMailProvider } from '../../src/modules/auth/signup';
import { StorageGateway } from '../../src/modules/attachments';
import { CompanyExportJob, CompanyExportModule, ExportPackager, isExcludedColumn } from '../../src/modules/company-export';
import { CompanyExportPublicController } from '../../src/modules/company-export/company-export.controller';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';
import { readZip, type ZipItem } from '../support/zip-reader';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, CompanyExportModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const KEY = randomBytes(32).toString('base64');
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  agencyOrg: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A (el dueño)
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B (el dueño)
  carol: 'c0000000-0000-4000-8000-0000000000c3', // advisor de A
  dave: 'd0000000-0000-4000-8000-0000000000d4', // personal de la agencia
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const HOUR = 3_600_000;

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let mail: MemoryMailProvider;
let storage: StorageGateway;
let job: CompanyExportJob;
let store: CompanyExportStore;
let rootToken = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE company_exports, organization_deletions, message_attachments, knowledge_documents, channel_accounts, contact_phones, notes, contacts, sessions, auth_throttle, trials, invitations, organization_members, organizations, users, plans, platform_audit CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [IDS.agencyOrg, 'agency', 'Agencia Demo']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.bob, 'bob@b.test', 'Beto Ruiz'], [IDS.carol, 'carol@a.test', null], [IDS.dave, 'dave@agencia.test', 'Dana Vega'], [IDS.root, 'root@plat.test', 'Raíz']];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.dave, IDS.agencyOrg, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  await admin.query(`UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [IDS.alice, ORG_A]);
  await admin.query(`UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [IDS.bob, ORG_B]);
  mail.companyDeletedOutbox.length = 0;
  mail.companyExportReadyOutbox.length = 0;
  storage.fake.objects.clear();
  storage.fake.down = false;
}

/** Datos de las dos empresas con marcas únicas para saber qué es de quién. */
async function seedData() {
  const rows: Array<[string, string, string]> = [[ORG_A, 'MARCA-A-1', '+593987000001'], [ORG_A, 'MARCA-A-2', '+593987000002'], [ORG_A, '=SUMA(1+1)', '+593987000003'], [ORG_B, 'MARCA-B-1', '+593987000101'], [ORG_B, 'MARCA-B-2', '+593987000102']];
  for (const [org, name, phone] of rows) {
    const id = uuidv7();
    await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES ($1,$2,$3)`, [id, org, name]);
    await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(),$1,$2,$3,true)`, [org, id, phone]);
  }
  for (const org of [ORG_A, ORG_B]) {
    const ch = (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'meta_cloud', $2) RETURNING id`, [org, `Canal ${org === ORG_A ? 'A' : 'B'}`])).rows[0].id as string;
    await admin.query(`UPDATE channel_accounts SET credentials_sealed = '\\x0102030405'::bytea, key_version = 1, token_last4 = '9876' WHERE id = $1`, [ch]);
  }
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AUDIO_TRANSCODER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
  mail = app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider;
  storage = app.get(StorageGateway);
  job = app.get(CompanyExportJob);
  store = app.get(CompanyExportStore);
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
/** El límite por IP de las páginas públicas (30/min) se cuenta por proceso: aquí se reemplaza por uno enorme para que la suite no lo agote, y la prueba del límite pone uno chico. */
const setIpLimiter = (limit: number): void => { (app.get(CompanyExportPublicController) as unknown as { perIp: WindowLimiter }).perIp = new WindowLimiter(limit, 60_000); };
beforeEach(async () => { await seed(); setIpLimiter(1_000_000); rootToken = await login('root@plat.test'); });

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string, password = PW): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password, token_transport: 'body' });
  expect(r.status).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const codeOf = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;

interface View { id: string; state: string; requested_via: string; parts: Array<{ n: number; filename: string; bytes: number }>; total_bytes: number; expires_at: string | null; error: string | null }
interface PlatformStatus { available: boolean; purge_after: string | null; export: View | null }

const nameOf: Record<string, string> = { [ORG_A]: 'Barbería Norte', [ORG_B]: 'Estudio Luna' };
const deleteCompany = (orgId: string) => call('POST', `/platform/companies/${orgId}/delete`, rootToken, { password: PW, confirm_name: nameOf[orgId], reason: 'La empresa pidió cerrar su cuenta' });
const requestExport = (orgId: string, password = PW, token = rootToken) => call('POST', `/platform/companies/${orgId}/export`, token, { password });
const exportStatus = (orgId: string, token = rootToken) => call('GET', `/platform/companies/${orgId}/export`, token);
const downloadPart = (orgId: string, part: number, token = rootToken) => call('POST', `/platform/companies/${orgId}/export/download`, token, { part });
const run = () => job.run(new Date());
const exportRows = async (orgId?: string) => (await admin.query(`SELECT id, organization_id, state, attempts, requested_via, expires_at, lease_until, error FROM company_exports ${orgId ? 'WHERE organization_id = $1' : ''} ORDER BY requested_at`, orgId ? [orgId] : [])).rows as Array<{ id: string; organization_id: string; state: string; attempts: number; requested_via: string; expires_at: Date | null; lease_until: Date | null; error: string | null }>;
const audits = async (action: string) => (await admin.query(`SELECT actor_user_id, target_org_id, details FROM platform_audit WHERE action = $1 ORDER BY at`, [action])).rows as Array<{ actor_user_id: string; target_org_id: string; details: Record<string, unknown> }>;
/** Todas las entradas de todas las partes de un paquete guardado. */
async function unzipAll(orgId: string): Promise<{ items: ZipItem[]; parts: number }> {
  const keys = [...storage.fake.objects.keys()].filter((k) => k.startsWith(`org/${orgId}/exports/`)).sort();
  return { items: keys.flatMap((k) => readZip(storage.fake.objects.get(k)!.body)), parts: keys.length };
}
const text = (items: ZipItem[], name: string): string => items.find((i) => i.name === name)?.data.toString('utf8') ?? '';
const lines = (s: string): Array<Record<string, unknown>> => s.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('acceso a las rutas de la Consola', () => {
  it('sin sesión 401 y con sesión de cliente, asesor o agencia 403; no crea nada', async () => {
    // Las personas de una empresa eliminada ya no pueden entrar: se prueba con quienes sí pueden (un cliente de B y el personal de una agencia) y sus sesiones siguen vivas
    const tokens = [await login('bob@b.test'), await login('dave@agencia.test')];
    await deleteCompany(ORG_A);
    for (const t of tokens) {
      expect((await exportStatus(ORG_A, t)).status).toBe(403);
      expect((await requestExport(ORG_A, PW, t)).status).toBe(403);
      expect((await downloadPart(ORG_A, 1, t)).status).toBe(403);
    }
    expect((await call('GET', `/platform/companies/${ORG_A}/export`)).status).toBe(401);
    expect((await call('POST', `/platform/companies/${ORG_A}/export`, undefined, { password: PW })).status).toBe(401);
    expect(await exportRows()).toHaveLength(0);
  });
});

describe('pedir la copia desde la Consola', () => {
  it('una empresa que NO está eliminada no se puede exportar (409 NOT_DELETED); lo inexistente tampoco', async () => {
    const r = await requestExport(ORG_A);
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe('NOT_DELETED');
    expect((await requestExport(uuidv7())).status).toBe(409);
    const s = await json<PlatformStatus>(await exportStatus(ORG_A));
    expect(s).toEqual({ available: false, purge_after: null, export: null });
    expect(await exportRows()).toHaveLength(0);
  });

  it('exige la contraseña del Súper Admin: una mala da 403, cuenta como intento de inicio de sesión (5 ⇒ 429) y no crea nada', async () => {
    await deleteCompany(ORG_A);
    const bad = await requestExport(ORG_A, 'mala-clave');
    expect(bad.status).toBe(403);
    expect(await codeOf(bad)).toBe('PASSWORD_INVALID');
    for (let i = 0; i < 4; i++) expect((await requestExport(ORG_A, 'mala-clave')).status).toBe(403);
    expect((await requestExport(ORG_A, 'mala-clave')).status).toBe(429);
    expect((await requestExport(ORG_A, PW)).status).toBe(429); // el límite es del usuario: ni la buena pasa
    expect(await exportRows()).toHaveLength(0);
  });

  it('pedir deja un solo pedido en cola, se audita, y pedir de nuevo devuelve el mismo (un paquete a la vez)', async () => {
    await deleteCompany(ORG_A);
    const first = await requestExport(ORG_A);
    expect(first.status).toBe(202);
    const v1 = await json<View>(first);
    expect(v1).toMatchObject({ state: 'queued', requested_via: 'platform', parts: [], total_bytes: 0 });
    const again = await json<View>(await requestExport(ORG_A));
    expect(again.id).toBe(v1.id);
    expect(await exportRows(ORG_A)).toHaveLength(1);
    const a = await audits('company.export_requested');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_user_id: IDS.root, target_org_id: ORG_A });
    expect(a[0]!.details).toMatchObject({ export_id: v1.id, via: 'platform' });
    const s = await json<PlatformStatus>(await exportStatus(ORG_A));
    expect(s.available).toBe(true);
    expect(s.export?.id).toBe(v1.id);
  });

  it('aislamiento A↔B: pedir la de A no toca a B; B (activa) no se puede exportar y su estado no ve nada de A', async () => {
    await deleteCompany(ORG_A);
    await requestExport(ORG_A);
    expect((await requestExport(ORG_B)).status).toBe(409);
    expect(await json<PlatformStatus>(await exportStatus(ORG_B))).toEqual({ available: false, purge_after: null, export: null });
    expect((await exportRows()).every((r) => r.organization_id === ORG_A)).toBe(true);
  });
});

describe('el paquete: contenido', () => {
  it('trae todas las tablas de la empresa y SOLO de la empresa; sin credenciales; con CSV, usuarios y LEEME', async () => {
    await seedData();
    await deleteCompany(ORG_A);
    await requestExport(ORG_A);
    expect(await run()).toBeGreaterThan(0);
    const { items, parts } = await unzipAll(ORG_A);
    expect(parts).toBe(1);

    // A↔B: nada de B en ninguna entrada
    for (const i of items) {
      const body = i.data.toString('utf8');
      expect(body, i.name).not.toContain('MARCA-B');
      expect(body, i.name).not.toContain('+593987000101');
      expect(body, i.name).not.toContain(ORG_B);
    }
    // contactos de A, completos
    const contacts = lines(text(items, 'datos/contacts.jsonl'));
    expect(contacts.map((c) => c['name']).sort()).toEqual(['=SUMA(1+1)', 'MARCA-A-1', 'MARCA-A-2']);
    expect(contacts.every((c) => c['organization_id'] === ORG_A)).toBe(true);
    expect(lines(text(items, 'datos/contact_phones.jsonl'))).toHaveLength(3);
    // CSV con BOM, encabezado y la fórmula neutralizada
    const csv = text(items, 'csv/contactos.csv');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("'=SUMA(1+1)");
    expect(csv).toContain('MARCA-A-1');
    expect(csv.split('\r\n').length).toBe(5); // encabezado + 3 filas + final vacío
    // credenciales: la conexión va, pero sin lo cifrado ni la versión de clave; sí los últimos 4
    const channels = lines(text(items, 'datos/channel_accounts.jsonl'));
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ name: 'Canal A', token_last4: '9876' });
    expect(channels[0]).not.toHaveProperty('credentials_sealed');
    expect(channels[0]).not.toHaveProperty('key_version');
    // personas con acceso, sin nada de contraseñas
    const people = JSON.parse(text(items, 'usuarios.json')) as Array<Record<string, unknown>>;
    expect(people.map((p) => p['email']).sort()).toEqual(['alice@a.test', 'carol@a.test']);
    expect(JSON.stringify(people)).not.toMatch(/hash|password/i);
    // LEEME y manifiesto
    const readme = text(items, 'LEEME.txt');
    expect(readme).toContain('Barbería Norte');
    expect(readme).toContain('contacts');
    expect(readme).toContain('credentials_sealed');
    const manifest = JSON.parse(text(items, 'manifest.json')) as { organization_id: string; tables: Array<{ name: string; rows: number; columns: string[]; excluded_columns: string[] }> };
    expect(manifest.organization_id).toBe(ORG_A);
    expect(manifest.tables.find((t) => t.name === 'contacts')?.rows).toBe(3);
  });

  it('el manifiesto cubre TODAS las tablas de negocio del catálogo y ninguna columna sensible llega al paquete', async () => {
    await seedData();
    await deleteCompany(ORG_A);
    await requestExport(ORG_A);
    await run();
    const { items } = await unzipAll(ORG_A);
    const manifest = JSON.parse(text(items, 'manifest.json')) as { tables: Array<{ name: string; columns: string[]; excluded_columns: string[] }> };
    const catalog = await admin.query(`
      SELECT c.relname AS t, a.attname AS col, ty.typname AS ty
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        JOIN pg_type ty ON ty.oid = a.atttypid
       WHERE c.relkind = 'r' AND c.relrowsecurity AND has_table_privilege('app_rw', c.oid, 'SELECT')
         AND EXISTS (SELECT 1 FROM pg_attribute o WHERE o.attrelid = c.oid AND o.attname = 'organization_id' AND NOT o.attisdropped)`);
    const expected = new Map<string, { kept: string[]; dropped: string[] }>();
    for (const r of catalog.rows as Array<{ t: string; col: string; ty: string }>) {
      const e = expected.get(r.t) ?? { kept: [], dropped: [] };
      (isExcludedColumn(r.col, r.ty) ? e.dropped : e.kept).push(r.col);
      expected.set(r.t, e);
    }
    expect(expected.size).toBeGreaterThan(50);
    expect(manifest.tables.map((t) => t.name).sort()).toEqual([...expected.keys()].filter((t) => expected.get(t)!.kept.length > 0).sort());
    for (const t of manifest.tables) {
      expect(t.columns.sort(), t.name).toEqual(expected.get(t.name)!.kept.sort());
      expect(t.excluded_columns.sort(), t.name).toEqual(expected.get(t.name)!.dropped.sort());
      // ninguna columna con nombre sensible sale, salvo las excepciones aprobadas a propósito
      for (const c of t.columns) expect(isExcludedColumn(c, 'text'), `${t.name}.${c}`).toBe(false);
    }
  });

  it('incluye los archivos del almacenamiento (adjuntos listos y biblioteca), deja fuera los no listos y cuenta los que faltan', async () => {
    await seedData();
    const conv = await prepareAttachments();
    expect(conv).toBeTruthy();
    await deleteCompany(ORG_A);
    await requestExport(ORG_A);
    await run();
    const { items } = await unzipAll(ORG_A);
    const adj = items.filter((i) => i.name.startsWith('archivos/adjuntos/'));
    const bib = items.filter((i) => i.name.startsWith('archivos/biblioteca/'));
    expect(adj).toHaveLength(1);
    expect(adj[0]!.name.endsWith('-foto.jpg')).toBe(true);
    expect(adj[0]!.data.equals(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]))).toBe(true);
    expect(bib).toHaveLength(1);
    expect(bib[0]!.data.toString('utf8')).toBe('precios de la barbería');
    // lo de B no entra
    expect(items.some((i) => i.name.includes('foto-de-b'))).toBe(false);
    const row = (await exportRows(ORG_A))[0]!;
    const counts = (await admin.query(`SELECT counts FROM company_exports WHERE id = $1`, [row.id])).rows[0].counts as { files: { included: number; missing: number; skipped: number } };
    expect(counts.files).toEqual({ included: 2, missing: 1, skipped: 1 });
  });

  /** Una conversación y cuatro adjuntos de A (listo, listo pero ausente, pendiente) más la biblioteca, y uno de B. */
  async function prepareAttachments(): Promise<string> {
    const contactA = (await admin.query(`SELECT id FROM contacts WHERE organization_id = $1 LIMIT 1`, [ORG_A])).rows[0].id as string;
    const contactB = (await admin.query(`SELECT id FROM contacts WHERE organization_id = $1 LIMIT 1`, [ORG_B])).rows[0].id as string;
    const chA = (await admin.query(`SELECT id FROM channel_accounts WHERE organization_id = $1`, [ORG_A])).rows[0].id as string;
    const chB = (await admin.query(`SELECT id FROM channel_accounts WHERE organization_id = $1`, [ORG_B])).rows[0].id as string;
    const mkConv = async (org: string, contact: string, ch: string) =>
      (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'unassigned', '+593987000001') RETURNING id`, [org, contact, ch])).rows[0].id as string;
    const convA = await mkConv(ORG_A, contactA, chA);
    const convB = await mkConv(ORG_B, contactB, chB);
    const att = async (org: string, conv: string, name: string, state: string, key: string | null) =>
      admin.query(`INSERT INTO message_attachments(id, organization_id, conversation_id, direction, kind, mime_type, filename, state, scan_status, storage_key, size_bytes) VALUES (gen_random_uuid(), $1, $2, 'in', 'image', 'image/jpeg', $3, $4, 'clean', $5, 6)`, [org, conv, name, state, key]);
    const keyReady = `org/${ORG_A}/attachments/${uuidv7()}`;
    await storage.put(keyReady, Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]), 'image/jpeg');
    await att(ORG_A, convA, 'foto.jpg', 'ready', keyReady);
    await att(ORG_A, convA, 'perdida.jpg', 'ready', `org/${ORG_A}/attachments/${uuidv7()}`); // lista en la base pero ya no está en el almacenamiento
    await att(ORG_A, convA, 'pendiente.jpg', 'pending', `org/${ORG_A}/attachments/${uuidv7()}`);
    const keyB = `org/${ORG_B}/attachments/${uuidv7()}`;
    await storage.put(keyB, Buffer.from('b'), 'image/jpeg');
    await att(ORG_B, convB, 'foto-de-b.jpg', 'ready', keyB);
    const docKey = `org/${ORG_A}/knowledge/${uuidv7()}`;
    await storage.put(docKey, Buffer.from('precios de la barbería'), 'text/plain');
    await admin.query(`INSERT INTO knowledge_documents(id, organization_id, name, kind, size_bytes, content_hash, storage_key, status, chunk_count) VALUES (gen_random_uuid(), $1, 'precios.txt', 'txt', 22, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $2, 'ready', 1)`, [ORG_A, docKey]);
    return convA;
  }
});

describe('el paquete: partes', () => {
  it('con límites chicos se parte en varias partes ZIP independientes, sin perder ni repetir filas; LEEME solo en la primera', async () => {
    // 60 contactos de A para que una tabla ocupe varias entradas y varias partes
    for (let i = 0; i < 60; i++) {
      const id = uuidv7();
      await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES ($1,$2,$3)`, [id, ORG_A, `CONTACTO-${String(i).padStart(3, '0')}-${'x'.repeat(60)}`]);
    }
    await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, 'MARCA-B-1')`, [ORG_B]);
    const packager = app.get(ExportPackager);
    const result = await packager.build(
      { organizationId: ORG_A, organizationName: 'Barbería Norte', requestedBy: IDS.root, actingAsSuperAdmin: true, generatedAt: new Date(), timeZone: 'America/Guayaquil', people: [], storagePrefix: `org/${ORG_A}/exports/prueba-partes/`, downloadBase: 'salesmart-barberia-norte' },
      { partLimitBytes: 6000, entryLimitBytes: 2500 },
    );
    expect(result.parts.length).toBeGreaterThan(2);
    expect(result.counts['contacts']).toBe(60);
    const all: ZipItem[] = [];
    result.parts.forEach((p, i) => {
      expect(p.n).toBe(i + 1);
      expect(p.key).toBe(`org/${ORG_A}/exports/prueba-partes/parte-${String(i + 1).padStart(3, '0')}.zip`);
      expect(p.filename).toBe(`salesmart-barberia-norte-parte-${i + 1}.zip`);
      const zip = storage.fake.objects.get(p.key)!.body;
      expect(zip.length).toBe(p.bytes);
      const items = readZip(zip); // cada parte es un ZIP completo y válido por sí sola
      expect(items.length).toBe(p.entries);
      all.push(...items);
    });
    const names = all.map((i) => i.name);
    expect(new Set(names).size).toBe(names.length); // ninguna entrada repetida entre partes
    expect(names.filter((n) => n === 'LEEME.txt')).toHaveLength(1);
    expect(readZip(storage.fake.objects.get(result.parts[0]!.key)!.body).map((i) => i.name)).toContain('LEEME.txt');
    // la tabla grande quedó en varias entradas numeradas y suman exactamente 60 filas
    const chunks = all.filter((i) => /^datos\/contacts(\.\d{4})?\.jsonl$/.test(i.name));
    expect(chunks.length).toBeGreaterThan(1);
    const rows = chunks.flatMap((c) => lines(c.data.toString('utf8')));
    expect(rows).toHaveLength(60);
    expect(new Set(rows.map((r) => r['id'])).size).toBe(60);
    expect(JSON.stringify(rows)).not.toContain('MARCA-B');
  });
});

describe('la tarea de fondo', () => {
  it('arma el paquete, lo deja listo con 48 horas, audita y la consola ve las partes y puede bajarlas con URL firmada de 15 minutos', async () => {
    await seedData();
    await deleteCompany(ORG_A);
    const v = await json<View>(await requestExport(ORG_A));
    const before = Date.now();
    await run();
    const s = await json<PlatformStatus>(await exportStatus(ORG_A));
    expect(s.export).toMatchObject({ id: v.id, state: 'ready', error: null });
    expect(s.export!.parts).toHaveLength(1);
    expect(s.export!.total_bytes).toBeGreaterThan(500);
    const hours = (new Date(s.export!.expires_at!).getTime() - before) / HOUR;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);
    // la respuesta jamás trae claves del almacenamiento
    expect(JSON.stringify(s)).not.toContain('org/');
    const d = await downloadPart(ORG_A, 1);
    expect(d.status).toBe(200);
    const link = await json<{ url: string; filename: string; expires_in_seconds: number }>(d);
    expect(link.expires_in_seconds).toBe(900);
    expect(link.filename).toBe('salesmart-barberia-norte-parte-1.zip');
    expect(link.url).toContain(`org/${ORG_A}/exports/${v.id}/parte-001.zip`);
    expect(link.url).toContain('disposition=attachment');
    expect(link.url).toContain('type=application%2Fzip');
    expect((await audits('company.export_ready'))[0]!.details).toMatchObject({ export_id: v.id, parts: 1 });
    expect((await audits('company.export_downloaded'))[0]).toMatchObject({ actor_user_id: IDS.root, target_org_id: ORG_A });
    expect(mail.companyExportReadyOutbox).toHaveLength(0); // lo pidió el Súper Admin: no hay correo al dueño
  });

  it('antes de estar listo no se puede bajar (409), una parte que no existe es 404 y el id de otra empresa no da nada', async () => {
    await deleteCompany(ORG_A);
    await requestExport(ORG_A);
    const early = await downloadPart(ORG_A, 1);
    expect(early.status).toBe(409);
    expect(await codeOf(early)).toBe('EXPORT_NOT_READY');
    await run();
    expect((await downloadPart(ORG_A, 99)).status).toBe(404);
    expect((await downloadPart(ORG_B, 1)).status).toBe(404); // B no está eliminada
    expect((await downloadPart(uuidv7(), 1)).status).toBe(404);
  });

  it('a las 48 horas borra las partes del almacenamiento y el paquete queda vencido: ya no se baja y se puede pedir otro', async () => {
    await seedData();
    await deleteCompany(ORG_A);
    await requestExport(ORG_A);
    await run();
    expect([...storage.fake.objects.keys()].some((k) => k.startsWith(`org/${ORG_A}/exports/`))).toBe(true);
    await admin.query(`UPDATE company_exports SET expires_at = now() - interval '1 minute'`);
    await run();
    expect([...storage.fake.objects.keys()].some((k) => k.startsWith(`org/${ORG_A}/exports/`))).toBe(false);
    expect((await exportRows(ORG_A))[0]!.state).toBe('expired');
    expect((await downloadPart(ORG_A, 1)).status).toBe(409);
    expect((await audits('company.export_expired'))).toHaveLength(1);
    const again = await json<View>(await requestExport(ORG_A)); // vencido: se puede pedir uno nuevo
    expect(again.state).toBe('queued');
    expect(await exportRows(ORG_A)).toHaveLength(2);
  });

  it('un paquete listo sin vencer se devuelve tal cual en vez de armar otro', async () => {
    await deleteCompany(ORG_A);
    const first = await json<View>(await requestExport(ORG_A));
    await run();
    const again = await json<View>(await requestExport(ORG_A));
    expect(again.id).toBe(first.id);
    expect(again.state).toBe('ready');
    expect(await exportRows(ORG_A)).toHaveLength(1);
  });

  it('si el almacenamiento falla reintenta (3 intentos) y luego queda «failed» con un código genérico, sin datos; se puede volver a pedir', async () => {
    await seedData();
    await deleteCompany(ORG_A);
    await requestExport(ORG_A);
    storage.fake.down = true;
    await run();
    expect((await exportRows(ORG_A))[0]).toMatchObject({ state: 'queued', attempts: 1, error: 'EXPORT_FAILED' });
    await run();
    await run();
    const failed = (await exportRows(ORG_A))[0]!;
    expect(failed).toMatchObject({ state: 'failed', attempts: 3, error: 'EXPORT_FAILED' });
    const s = await json<PlatformStatus>(await exportStatus(ORG_A));
    expect(s.export).toMatchObject({ state: 'failed', error: 'EXPORT_FAILED' });
    expect(JSON.stringify(s)).not.toMatch(/MARCA|storage|S3|ECONN/i);
    storage.fake.down = false;
    expect((await requestExport(ORG_A)).status).toBe(202);
    await run();
    expect((await exportRows(ORG_A)).map((r) => r.state)).toEqual(['failed', 'ready']);
  });

  it('un trabajo cuyo proceso murió (arrendamiento vencido) lo retoma otra pasada', async () => {
    await deleteCompany(ORG_A);
    await requestExport(ORG_A);
    const claimed = await store.claim(new Date(), 5 * 60_000);
    expect(claimed?.state).toBe('running');
    expect(await store.claim(new Date(), 5 * 60_000)).toBeNull(); // mientras el arrendamiento vale, nadie más lo toma
    await admin.query(`UPDATE company_exports SET lease_until = now() - interval '1 minute'`);
    await run(); // lo toma, lo arma y lo deja listo
    expect((await exportRows(ORG_A))[0]).toMatchObject({ state: 'ready', attempts: 2 });
  });

  it('si la empresa se recupera antes de armar, el pedido falla y no se lee nada', async () => {
    await deleteCompany(ORG_A);
    await requestExport(ORG_A);
    expect((await call('POST', `/platform/companies/${ORG_A}/recover`, rootToken, { password: PW })).status).toBe(200);
    await run();
    expect((await exportRows(ORG_A))[0]).toMatchObject({ state: 'failed', error: 'COMPANY_NOT_DELETED' });
    expect([...storage.fake.objects.keys()].some((k) => k.startsWith(`org/${ORG_A}/exports/`))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const pub = (path: string, body: unknown) => call('POST', `/public/company-export/${path}`, undefined, body);
function ownerToken(email = 'alice@a.test'): string {
  const m = [...mail.companyDeletedOutbox].reverse().find((x) => x.to === email && x.audience === 'owner');
  expect(m, `correo de eliminación a ${email}`).toBeTruthy();
  expect(m!.exportUrl).toMatch(/^https:\/\/app\.ejemplo\.test\/company-export#token=[A-Za-z0-9_-]{43}$/);
  return new URL(m!.exportUrl!).hash.replace('#token=', '');
}

describe('el dueño, con el enlace de su correo', () => {
  it('el correo de eliminación lleva el enlace SOLO para el dueño (no para la agencia ni para otros) y el token no se guarda en la base', async () => {
    await admin.query(`UPDATE organizations SET parent_agency_id = $1 WHERE id = $2`, [IDS.agencyOrg, ORG_A]);
    await deleteCompany(ORG_A);
    const toOwner = mail.companyDeletedOutbox.filter((m) => m.audience === 'owner');
    const toAgency = mail.companyDeletedOutbox.filter((m) => m.audience === 'agency');
    expect(toOwner).toHaveLength(1);
    expect(toAgency.length).toBeGreaterThan(0);
    for (const m of toAgency) expect(m.exportUrl).toBeUndefined();
    const token = ownerToken();
    const stored = (await admin.query(`SELECT export_token_hash FROM organization_deletions`)).rows[0].export_token_hash as string;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(token);
    expect(JSON.stringify((await admin.query(`SELECT * FROM organization_deletions`)).rows)).not.toContain(token);
  });

  it('estado por token: dice el nombre y el plazo, sin contraseña; un token que no vale es siempre 404 con el mismo cuerpo', async () => {
    await deleteCompany(ORG_A);
    const token = ownerToken();
    const ok = await pub('status', { token });
    expect(ok.status).toBe(200);
    expect(await json<{ organization_name: string; purge_after: string; export: View | null }>(ok)).toMatchObject({ organization_name: 'Barbería Norte', export: null });
    const bad = await pub('status', { token: 'x'.repeat(43) });
    const alsoBad = await pub('status', { token: randomBytes(32).toString('base64url') });
    expect(bad.status).toBe(404);
    expect(alsoBad.status).toBe(404);
    const strip = (b: { error: { request_id?: string } }) => ({ ...b.error, request_id: undefined });
    expect(strip(await json<{ error: { request_id?: string } }>(bad))).toEqual(strip(await json<{ error: { request_id?: string } }>(alsoBad)));
    expect((await pub('status', { token: 'corto' })).status).toBe(400); // no es un token
    expect((await pub('status', {})).status).toBe(400);
  });

  it('pedir exige la contraseña DEL DUEÑO: mala 403, 5 fallos ⇒ 429 (el límite del inicio de sesión), la de otra persona no sirve', async () => {
    await deleteCompany(ORG_A);
    const token = ownerToken();
    expect((await pub('request', { token })).status).toBe(400);
    const bad = await pub('request', { token, password: 'mala' });
    expect(bad.status).toBe(403);
    expect(await codeOf(bad)).toBe('PASSWORD_INVALID');
    // la contraseña del Súper Admin/otra persona es la misma cadena aquí; lo que cuenta es de QUIÉN es la cuenta: se prueba con un dueño de otra clave
    await admin.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await new Argon2idHasher().hash('Otra-Clave-77!'), IDS.alice]);
    expect((await pub('request', { token, password: PW })).status).toBe(403);
    for (let i = 0; i < 3; i++) expect((await pub('request', { token, password: 'mala' })).status).toBe(403);
    expect((await pub('request', { token, password: 'Otra-Clave-77!' })).status).toBe(429);
    expect(await exportRows()).toHaveLength(0);
  });

  it('flujo completo: pide, la tarea lo arma, llega el correo «listo» con OTRO enlace, y baja con contraseña por cualquiera de los dos tokens', async () => {
    await seedData();
    await deleteCompany(ORG_A);
    const token = ownerToken();
    const asked = await pub('request', { token, password: PW });
    expect(asked.status).toBe(202);
    const v = await json<View>(asked);
    expect(v).toMatchObject({ state: 'queued', requested_via: 'owner' });
    expect((await audits('company.export_requested'))[0]).toMatchObject({ actor_user_id: IDS.alice, target_org_id: ORG_A });
    // «uno a la vez»: pedir de nuevo es el mismo
    expect((await json<View>(await pub('request', { token, password: PW }))).id).toBe(v.id);
    // todavía no se puede bajar
    const early = await pub('download', { token, password: PW, part: 1 });
    expect(early.status).toBe(409);

    await run();
    expect(mail.companyExportReadyOutbox).toHaveLength(1);
    const ready = mail.companyExportReadyOutbox[0]!;
    expect(ready).toMatchObject({ to: 'alice@a.test', organizationName: 'Barbería Norte', parts: 1 });
    expect(ready.downloadUrl).toMatch(/^https:\/\/app\.ejemplo\.test\/company-export#token=[A-Za-z0-9_-]{43}$/);
    const token2 = new URL(ready.downloadUrl).hash.replace('#token=', '');
    expect(token2).not.toBe(token);
    const stored = (await admin.query(`SELECT download_token_hash FROM company_exports`)).rows[0].download_token_hash as string;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify((await admin.query(`SELECT * FROM company_exports`)).rows)).not.toContain(token2);

    const st = await json<{ export: View }>(await pub('status', { token }));
    expect(st.export).toMatchObject({ state: 'ready' });
    for (const t of [token, token2]) {
      expect((await pub('download', { token: t, password: 'mala', part: 1 })).status).toBe(403);
      const d = await pub('download', { token: t, password: PW, part: 1 });
      expect(d.status).toBe(200);
      expect((await json<{ url: string; expires_in_seconds: number }>(d)).url).toContain(`org/${ORG_A}/exports/${v.id}/parte-001.zip`);
    }
    expect((await pub('download', { token, password: PW, part: 7 })).status).toBe(404);
    const dl = await audits('company.export_downloaded');
    expect(dl).toHaveLength(2);
    expect(dl[0]).toMatchObject({ actor_user_id: IDS.alice });
    // el contenido que se entrega es el de A y solo el de A
    const { items } = await unzipAll(ORG_A);
    expect(text(items, 'datos/contacts.jsonl')).not.toContain('MARCA-B');
  });

  it('aislamiento A↔B: el token de A nunca da acceso a la copia de B y viceversa', async () => {
    await seedData();
    await deleteCompany(ORG_A);
    await deleteCompany(ORG_B);
    const tokenA = ownerToken('alice@a.test');
    const tokenB = ownerToken('bob@b.test');
    expect(tokenA).not.toBe(tokenB);
    expect((await json<{ organization_name: string }>(await pub('status', { token: tokenA }))).organization_name).toBe('Barbería Norte');
    expect((await json<{ organization_name: string }>(await pub('status', { token: tokenB }))).organization_name).toBe('Estudio Luna');
    // la contraseña de Bob no vale con el token de A (el dueño de A es Alicia)
    await admin.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await new Argon2idHasher().hash('Clave-De-Bob-55!'), IDS.bob]);
    expect((await pub('request', { token: tokenA, password: 'Clave-De-Bob-55!' })).status).toBe(403);
    expect(await pub('request', { token: tokenA, password: PW }).then((r) => r.status)).toBe(202);
    expect(await pub('request', { token: tokenB, password: 'Clave-De-Bob-55!' }).then((r) => r.status)).toBe(202);
    await run();
    await run();
    const a = await unzipAll(ORG_A);
    const b = await unzipAll(ORG_B);
    for (const i of a.items) expect(i.data.toString('utf8'), `A/${i.name}`).not.toContain('MARCA-B');
    for (const i of b.items) expect(i.data.toString('utf8'), `B/${i.name}`).not.toContain('MARCA-A');
    const dlA = await json<{ url: string }>(await pub('download', { token: tokenA, password: PW, part: 1 }));
    expect(dlA.url).toContain(`org/${ORG_A}/exports/`);
    expect(dlA.url).not.toContain(ORG_B);
    const dlB = await json<{ url: string }>(await pub('download', { token: tokenB, password: 'Clave-De-Bob-55!', part: 1 }));
    expect(dlB.url).toContain(`org/${ORG_B}/exports/`);
    expect(dlB.url).not.toContain(ORG_A);
  });

  it('si la empresa se recupera, el enlace deja de valer (404) y no se puede pedir', async () => {
    await deleteCompany(ORG_A);
    const token = ownerToken();
    expect((await pub('status', { token })).status).toBe(200);
    expect((await call('POST', `/platform/companies/${ORG_A}/recover`, rootToken, { password: PW })).status).toBe(200);
    expect((await pub('status', { token })).status).toBe(404);
    expect((await pub('request', { token, password: PW })).status).toBe(404);
    expect((await pub('download', { token, password: PW, part: 1 })).status).toBe(404);
  });

  it('con el plazo vencido el enlace deja de valer aunque el borrado definitivo no haya corrido', async () => {
    await deleteCompany(ORG_A);
    const token = ownerToken();
    await admin.query(`UPDATE organization_deletions SET requested_at = now() - interval '9 days', purge_after = now() - interval '2 days'`);
    expect((await pub('status', { token })).status).toBe(404);
    expect((await requestExport(ORG_A)).status).toBe(409);
  });

  it('un dueño que ya no puede iniciar sesión (desactivado) no puede usar el enlace', async () => {
    await deleteCompany(ORG_A);
    const token = ownerToken();
    await admin.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [IDS.alice]);
    expect((await pub('request', { token, password: PW })).status).toBe(404);
  });
});

describe('seguridad de las respuestas', () => {
  it('el límite por dirección IP frena las páginas públicas (429 con Retry-After) sin dar pistas del token', async () => {
    await deleteCompany(ORG_A);
    const token = ownerToken();
    setIpLimiter(3);
    for (let i = 0; i < 3; i++) expect((await pub('status', { token })).status).toBe(200);
    const blocked = await pub('status', { token });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await pub('status', { token: 'x'.repeat(43) })).status).toBe(429); // con token bueno o malo, igual
  });

  it('las páginas públicas y las de la Consola no se guardan en cachés', async () => {
    await deleteCompany(ORG_A);
    const token = ownerToken();
    for (const r of [await pub('status', { token }), await exportStatus(ORG_A), await requestExport(ORG_A)]) expect(r.headers.get('cache-control')).toContain('no-store');
  });

  it('el cuerpo no admite campos de más ni tipos equivocados', async () => {
    await deleteCompany(ORG_A);
    const token = ownerToken();
    expect((await pub('status', { token, extra: 1 })).status).toBe(400);
    expect((await pub('download', { token, password: PW, part: '1' })).status).toBe(400);
    expect((await pub('download', { token, password: PW, part: 0 })).status).toBe(400);
    expect((await call('POST', `/platform/companies/${ORG_A}/export`, rootToken, { password: PW, organization_id: ORG_B })).status).toBe(400);
  });
});
