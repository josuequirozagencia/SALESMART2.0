// F3c (ADR-59 #10–12, #14) — la tarea de fondo del borrado definitivo, de punta a punta con PostgreSQL real: eliminar con la API (F3a), vencer el plazo y comprobar que NO queda nada de esa empresa (filas, archivos,
// instancias de WhatsApp por QR, identidad) y que NADA de otra empresa cambió. Las funciones SQL por sí solas se prueban en company-purge-sql.test.ts.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uuidv7 } from '@sales-smart/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { StorageGateway } from '../../src/modules/attachments';
import { AuthModule, CompanyPurgeStore, LocalAccessResolver } from '../../src/modules/auth';
import { MAIL_PROVIDER, MemoryMailProvider } from '../../src/modules/auth/signup';
import { CompanyExportModule } from '../../src/modules/company-export';
import { CompanyPurgeJob, CompanyPurgeModule } from '../../src/modules/company-purge';
import { OrganizationsModule } from '../../src/modules/organizations';
import { FAKE_QR_KEY, FakeQrSession, QR_SESSION, QrConnectionsService, QrSessionError } from '../../src/modules/qr';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, CompanyExportModule, CompanyPurgeModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const KEY = randomBytes(32).toString('base64');
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  agencyOrg: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  alice: 'a0000000-0000-4000-8000-00000000000a', // dueña de A (exclusiva de A)
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A y de B
  bob: 'b0000000-0000-4000-8000-00000000000b', // dueño de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // personal de la agencia
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const INSTANCE_A = 'inst-aaaaaaaa';
const INSTANCE_B = 'inst-bbbbbbbb';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let mail: MemoryMailProvider;
let storage: StorageGateway;
let job: CompanyPurgeJob;
let store: CompanyPurgeStore;
let qrFake: FakeQrSession;
let rootToken = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE pipeline_stages, pipelines, company_exports, organization_deletions, qr_routes, ghl_routes, message_attachments, knowledge_documents, qr_accounts, messages, conversations, channel_accounts, contact_phones, contacts, sessions, auth_throttle, trials, invitations, organization_members, organizations, users, plans, platform_audit CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [IDS.agencyOrg, 'agency', 'Agencia Demo']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@ab.test', 'Carla Mena'], [IDS.bob, 'bob@b.test', 'Beto Ruiz'], [IDS.dave, 'dave@agencia.test', 'Dana Vega'], [IDS.root, 'root@plat.test', 'Raíz']];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.carol, ORG_B, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.dave, IDS.agencyOrg, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  await admin.query(`UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [IDS.alice, ORG_A]);
  await admin.query(`UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [IDS.bob, ORG_B]);
  mail.companyDeletedOutbox.length = 0;
  mail.companyPurgeNoticeOutbox.length = 0;
  storage.fake.objects.clear();
  storage.fake.down = false;
  qrFake.reset();
  vi.restoreAllMocks();
}

/** Datos de negocio, un canal con sesión QR, archivos y una ruta de GoHighLevel por empresa. */
async function seedData(org: string, tag: string, instance: string, contacts = 3) {
  const pipe = (await admin.query(`INSERT INTO pipelines(organization_id, id, name, position) VALUES ($1, gen_random_uuid(), $2, 0) RETURNING id`, [org, `Ventas ${tag}`])).rows[0].id as string;
  const stage = (await admin.query(`INSERT INTO pipeline_stages(organization_id, id, pipeline_id, name, position, kind) VALUES ($1, gen_random_uuid(), $2, 'Cita', 0, 'open') RETURNING id`, [org, pipe])).rows[0].id as string;
  await admin.query(`UPDATE pipelines SET appointment_stage_id = $1 WHERE id = $2`, [stage, pipe]);
  const ch = (await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'evolution', $2) RETURNING id`, [org, `Canal ${tag}`])).rows[0].id as string;
  await admin.query(`INSERT INTO qr_accounts(organization_id, channel_account_id, instance_name) VALUES ($1, $2, $3)`, [org, ch, instance]);
  qrFake.instances.set(instance, { state: 'open', webhookUrl: 'https://x.test/hook', qrCalls: 0 });
  await admin.query(`INSERT INTO ghl_routes(id, organization_id, secret_hash) VALUES (gen_random_uuid(), $1, $2)`, [org, 'a'.repeat(64)]);
  for (let i = 0; i < contacts; i++) {
    const c = (await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [org, `Contacto ${tag}-${i}`])).rows[0].id as string;
    await admin.query(`INSERT INTO contact_phones(id, organization_id, contact_id, e164, is_primary) VALUES (gen_random_uuid(), $1, $2, $3, true)`, [org, c, `+5939${tag === 'A' ? '7' : '8'}${String(1000000 + i)}`]);
    if (i === 0) {
      const conv = (await admin.query(`INSERT INTO conversations(id, organization_id, contact_id, channel_account_id, status, peer_id) VALUES (gen_random_uuid(), $1, $2, $3, 'unassigned', '+593970000000') RETURNING id`, [org, c, ch])).rows[0].id as string;
      await admin.query(`INSERT INTO messages(id, organization_id, conversation_id, channel_account_id, direction, sender_type, kind, body, status, sent_at) VALUES (gen_random_uuid(), $1, $2, $3, 'in', 'contact', 'text', $4, 'received', now())`, [org, conv, ch, `hola ${tag}`]);
      const key = `org/${org}/attachments/${uuidv7()}`;
      await storage.put(key, Buffer.from(`archivo ${tag}`), 'text/plain');
      await admin.query(`INSERT INTO message_attachments(id, organization_id, conversation_id, direction, kind, mime_type, filename, state, scan_status, storage_key, size_bytes) VALUES (gen_random_uuid(), $1, $2, 'in', 'image', 'image/jpeg', 'foto.jpg', 'ready', 'clean', $3, 5)`, [org, conv, key]);
    }
  }
  await storage.put(`org/${org}/exports/${uuidv7()}/parte-001.zip`, Buffer.from('zip'), 'application/zip'); // un paquete de «Descargar todo» (F3b)
  await storage.put(`org/${org}/knowledge/${uuidv7()}`, Buffer.from('doc'), 'text/plain');
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'PROVIDER_CREDENTIALS_KEY', 'WHATSAPP_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'QR_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', WHATSAPP_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', QR_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AUDIO_TRANSCODER: 'fake', PROVIDER_CREDENTIALS_KEY: KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
  mail = app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider;
  storage = app.get(StorageGateway);
  job = app.get(CompanyPurgeJob);
  store = app.get(CompanyPurgeStore);
  qrFake = app.get(QR_SESSION) as FakeQrSession;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  // Las credenciales de Evolution de la plataforma viven en la bóveda; aquí se simulan
  vi.spyOn(app.get(QrConnectionsService), 'credentials').mockResolvedValue({ baseUrl: 'https://evolution.test', apiKey: FAKE_QR_KEY });
  rootToken = await login('root@plat.test');
});

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string, password = PW): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password, token_transport: 'body' });
  expect(r.status).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const nameOf: Record<string, string> = { [ORG_A]: 'Barbería Norte', [ORG_B]: 'Estudio Luna', [IDS.agencyOrg]: 'Agencia Demo' };
const deleteCompany = (orgId: string) => call('POST', `/platform/companies/${orgId}/delete`, rootToken, { password: PW, confirm_name: nameOf[orgId], reason: 'La empresa pidió cerrar su cuenta' });
const recover = (orgId: string) => call('POST', `/platform/companies/${orgId}/recover`, rootToken, { password: PW });
/** Hace como si hubieran pasado 7 días desde que se eliminó. */
const expire = (orgId: string) => admin.query(`UPDATE organization_deletions SET requested_at = now() - interval '9 days', purge_after = now() - interval '1 hour' WHERE organization_id = $1`, [orgId]);
const run = () => job.run(new Date());
const deletion = async (orgId: string) => (await admin.query(`SELECT state, purge_attempts, purge_error, purge_next_attempt_at, purge_lease_until, purged_at, purge_counts, notice_sent_at, export_token_hash FROM organization_deletions WHERE organization_id = $1`, [orgId])).rows[0] as { state: string; purge_attempts: number; purge_error: string | null; purge_next_attempt_at: Date | null; purge_lease_until: Date | null; purged_at: Date | null; purge_counts: Record<string, unknown>; notice_sent_at: Date | null; export_token_hash: string | null };
const orgRow = async (orgId: string) => (await admin.query(`SELECT name, status, owner_user_id FROM organizations WHERE id = $1`, [orgId])).rows[0] as { name: string; status: string; owner_user_id: string | null };
const audits = async (action: string) => (await admin.query(`SELECT actor_user_id, target_org_id, details FROM platform_audit WHERE action = $1 ORDER BY at`, [action])).rows as Array<{ actor_user_id: string; target_org_id: string; details: Record<string, unknown> }>;
const keysUnder = (org: string) => [...storage.fake.objects.keys()].filter((k) => k.startsWith(`org/${org}/`));

async function tenantTables(): Promise<string[]> {
  const r = await admin.query(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped) ORDER BY 1`);
  return r.rows.map((x: { t: string }) => x.t);
}
async function fingerprint(org: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of await tenantTables()) {
    const r = await admin.query(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM "${t}" x WHERE organization_id = $1`, [org]);
    out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}
const rowsOf = async (org: string): Promise<number> => {
  let total = 0;
  for (const t of await tenantTables()) total += (await admin.query(`SELECT count(*)::int AS n FROM "${t}" WHERE organization_id = $1`, [org])).rows[0].n as number;
  return total;
};
const n = async (sql: string, p: unknown[]) => (await admin.query(sql, p)).rows[0].n as number;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('antes del plazo', () => {
  it('una empresa eliminada hace un día NO se toca: ni datos, ni archivos, ni instancias, ni estado', async () => {
    await seedData(ORG_A, 'A', INSTANCE_A);
    await deleteCompany(ORG_A);
    const rows = await rowsOf(ORG_A);
    const files = keysUnder(ORG_A).length;
    expect(await run()).toBe(0);
    expect(await rowsOf(ORG_A)).toBe(rows);
    expect(keysUnder(ORG_A)).toHaveLength(files);
    expect(qrFake.instances.has(INSTANCE_A)).toBe(true);
    expect(await deletion(ORG_A)).toMatchObject({ state: 'scheduled', purge_attempts: 0 });
    expect(await orgRow(ORG_A)).toMatchObject({ name: 'Barbería Norte', status: 'deleted' });
  });

  it('una empresa VIVA nunca se purga, aunque su plazo "pasara" por un dato mal puesto', async () => {
    await seedData(ORG_B, 'B', INSTANCE_B);
    expect(await run()).toBe(0);
    expect(await store.claimDue(new Date(), 60_000)).toBeNull();
    expect(await rowsOf(ORG_B)).toBeGreaterThan(5);
  });
});

describe('aviso 24 horas antes (ADR-59 #14)', () => {
  it('avisa una sola vez al dueño y al personal de la agencia cuando falta menos de un día; antes no', async () => {
    await admin.query(`UPDATE organizations SET parent_agency_id = $1 WHERE id = $2`, [IDS.agencyOrg, ORG_A]);
    await deleteCompany(ORG_A);
    mail.companyDeletedOutbox.length = 0;
    await run();
    expect(mail.companyPurgeNoticeOutbox).toHaveLength(0); // quedan 7 días
    await admin.query(`UPDATE organization_deletions SET purge_after = now() + interval '12 hours' WHERE organization_id = $1`, [ORG_A]);
    await run();
    const sent = mail.companyPurgeNoticeOutbox;
    expect(sent.map((m) => `${m.to}:${m.audience}`).sort()).toEqual(['alice@a.test:owner', 'dave@agencia.test:agency']);
    expect(sent[0]).toMatchObject({ organizationName: 'Barbería Norte', timeZone: 'America/Guayaquil' });
    expect((await deletion(ORG_A)).notice_sent_at).not.toBeNull();
    await run();
    expect(mail.companyPurgeNoticeOutbox).toHaveLength(2); // no se repite
  });

  it('si el correo falla no se marca como avisado y se reintenta; una empresa recuperada no recibe el aviso', async () => {
    await deleteCompany(ORG_A);
    await admin.query(`UPDATE organization_deletions SET purge_after = now() + interval '10 hours' WHERE organization_id = $1`, [ORG_A]);
    mail.failNext = true;
    await run();
    expect(mail.companyPurgeNoticeOutbox).toHaveLength(0);
    expect((await deletion(ORG_A)).notice_sent_at).toBeNull();
    await run();
    expect(mail.companyPurgeNoticeOutbox).toHaveLength(1);
    await seed();
    rootToken = await login('root@plat.test'); // seed() reinicia las personas y sus sesiones
    await seedData(ORG_A, 'A', INSTANCE_A);
    await deleteCompany(ORG_A);
    await admin.query(`UPDATE organization_deletions SET purge_after = now() + interval '10 hours' WHERE organization_id = $1`, [ORG_A]);
    expect((await recover(ORG_A)).status).toBe(200);
    await run();
    expect(mail.companyPurgeNoticeOutbox).toHaveLength(0);
  });
});

describe('el borrado definitivo', () => {
  it('vence el plazo: no queda NADA de la empresa (filas, archivos, instancia QR, identidad) y NADA de otra cambia', async () => {
    await seedData(ORG_A, 'A', INSTANCE_A, 5);
    await seedData(ORG_B, 'B', INSTANCE_B, 4);
    const beforeB = await fingerprint(ORG_B);
    const filesB = keysUnder(ORG_B).sort();
    const memberB = await n(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [ORG_B]);
    expect((await deleteCompany(ORG_A)).status).toBe(200);
    expect(await rowsOf(ORG_A)).toBeGreaterThan(15);
    await expire(ORG_A);

    expect(await run()).toBeGreaterThan(0);

    // negocio
    expect(await rowsOf(ORG_A)).toBe(0);
    // archivos (adjuntos, biblioteca y el paquete de «Descargar todo»)
    expect(keysUnder(ORG_A)).toEqual([]);
    // Evolution
    expect(qrFake.instances.has(INSTANCE_A)).toBe(false);
    // identidad
    expect(await n(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [ORG_A])).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM ghl_routes WHERE organization_id = $1`, [ORG_A])).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM sessions WHERE active_org_id = $1 OR home_org_id = $1`, [ORG_A])).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [IDS.alice])).toBe(0); // exclusiva de A
    expect(await n(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [IDS.carol])).toBe(1); // también está en B
    // la lápida y la evidencia
    expect(await orgRow(ORG_A)).toEqual({ name: '[empresa eliminada]', status: 'purged', owner_user_id: null });
    const d = await deletion(ORG_A);
    expect(d).toMatchObject({ state: 'purged', purge_error: null, purge_lease_until: null, export_token_hash: null });
    expect(d.purged_at).not.toBeNull();
    const counts = d.purge_counts as { tables: Record<string, number>; identity: Record<string, number>; files: number; qr: { instances: number; failed: number; skipped: boolean } };
    expect(counts.tables['contacts']).toBe(5);
    expect(counts.identity['organization_members']).toBe(2);
    expect(counts.files).toBe(3); // el adjunto, el paquete de «Descargar todo» y el documento de la biblioteca
    expect(counts.qr).toEqual({ instances: 1, failed: 0, skipped: false });
    const audit = await audits('company.purged');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: IDS.root, target_org_id: ORG_A });
    expect(audit[0]!.details).toMatchObject({ name: 'Barbería Norte', kind: 'client' });
    expect(JSON.stringify(audit[0]!.details)).not.toMatch(/Contacto|alice@|\+593/); // sin datos personales

    // B, idéntica
    expect(await fingerprint(ORG_B)).toEqual(beforeB);
    expect(keysUnder(ORG_B).sort()).toEqual(filesB);
    expect(qrFake.instances.has(INSTANCE_B)).toBe(true);
    expect(await n(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [ORG_B])).toBe(memberB);
    expect(await orgRow(ORG_B)).toMatchObject({ name: 'Estudio Luna', status: 'active' });
  });

  it('después: no se puede recuperar, el enlace del dueño no vale, nadie entra y una segunda pasada no hace nada', async () => {
    await seedData(ORG_A, 'A', INSTANCE_A);
    await deleteCompany(ORG_A);
    const token = new URL(mail.companyDeletedOutbox.find((m) => m.audience === 'owner')!.exportUrl!).hash.replace('#token=', '');
    await expire(ORG_A);
    await run();
    expect((await recover(ORG_A)).status).toBe(404); // ya no existe: no hay nada que recuperar
    expect((await call('POST', '/public/company-export/status', undefined, { token })).status).toBe(404);
    expect((await call('POST', '/auth/login', undefined, { email: 'alice@a.test', password: PW, token_transport: 'body' })).status).toBe(401);
    expect(await run()).toBe(0);
    expect(await audits('company.purged')).toHaveLength(1);
  });

  it('una agencia sin clientes también se borra (sin datos de negocio; su personal exclusivo y la lápida)', async () => {
    expect((await deleteCompany(IDS.agencyOrg)).status).toBe(200);
    await expire(IDS.agencyOrg);
    await run();
    expect(await orgRow(IDS.agencyOrg)).toMatchObject({ name: '[empresa eliminada]', status: 'purged' });
    expect(await n(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [IDS.dave])).toBe(0);
    expect((await deletion(IDS.agencyOrg)).state).toBe('purged');
  });

  it('la fila de la empresa queda como lápida: el historial de plataforma y los identificadores no quedan colgando', async () => {
    await deleteCompany(ORG_A);
    await expire(ORG_A);
    await run();
    expect(await n(`SELECT count(*)::int AS n FROM organizations WHERE id = $1`, [ORG_A])).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM platform_audit WHERE target_org_id = $1 AND action = 'company.deleted'`, [ORG_A])).toBe(1); // la auditoría de plataforma se conserva
    expect(await n(`SELECT count(*)::int AS n FROM organization_deletions WHERE organization_id = $1`, [ORG_A])).toBe(1);
  });
});

describe('fallos y reintentos', () => {
  it('el almacenamiento no responde: queda purge_failed con un código genérico y con la base INTACTA; al volver, termina', async () => {
    await seedData(ORG_A, 'A', INSTANCE_A);
    await deleteCompany(ORG_A);
    await expire(ORG_A);
    const rows = await rowsOf(ORG_A);
    storage.fake.down = true;
    await run();
    const d = await deletion(ORG_A);
    expect(d).toMatchObject({ state: 'purge_failed', purge_error: 'STORAGE_UNAVAILABLE', purge_attempts: 1, purge_lease_until: null });
    expect(d.purge_next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await rowsOf(ORG_A)).toBe(rows); // los archivos se borran ANTES que la base: si fallan, la base sigue completa y reintentable
    expect(await orgRow(ORG_A)).toMatchObject({ status: 'deleted' });
    expect(await run()).toBe(0); // aún no toca reintentar
    storage.fake.down = false;
    await admin.query(`UPDATE organization_deletions SET purge_next_attempt_at = now() - interval '1 minute' WHERE organization_id = $1`, [ORG_A]);
    await run();
    expect(await deletion(ORG_A)).toMatchObject({ state: 'purged', purge_attempts: 2 });
    expect(await rowsOf(ORG_A)).toBe(0);
  });

  it('Evolution no responde: reintenta y, tras varios intentos, sigue y lo anota (una instancia huérfana no impide borrar los datos)', async () => {
    await seedData(ORG_A, 'A', INSTANCE_A);
    await deleteCompany(ORG_A);
    await expire(ORG_A);
    vi.spyOn(qrFake, 'deleteInstance').mockRejectedValue(new QrSessionError('unavailable', 'sin respuesta'));
    await run();
    expect(await deletion(ORG_A)).toMatchObject({ state: 'purge_failed', purge_error: 'QR_CLEANUP_FAILED', purge_attempts: 1 });
    expect(await rowsOf(ORG_A)).toBeGreaterThan(5); // aún no se tocó la base
    await admin.query(`UPDATE organization_deletions SET purge_attempts = 2, purge_next_attempt_at = now() - interval '1 minute' WHERE organization_id = $1`, [ORG_A]);
    await run(); // tercer intento: se rinde con Evolution y sigue
    const d = await deletion(ORG_A);
    expect(d.state).toBe('purged');
    expect((d.purge_counts as { qr: { failed: number } }).qr.failed).toBe(1);
    expect(await rowsOf(ORG_A)).toBe(0);
  });

  it('sin credenciales de Evolution no se puede cerrar la sesión: se anota y se borra todo lo demás', async () => {
    await seedData(ORG_A, 'A', INSTANCE_A);
    await deleteCompany(ORG_A);
    await expire(ORG_A);
    vi.spyOn(app.get(QrConnectionsService), 'credentials').mockResolvedValue(null);
    await run();
    const d = await deletion(ORG_A);
    expect(d.state).toBe('purged');
    expect((d.purge_counts as { qr: { skipped: boolean } }).qr.skipped).toBe(true);
    expect(await rowsOf(ORG_A)).toBe(0);
  });

  it('un corte entre la identidad y el cierre: la empresa ya es lápida pero la eliminación sigue «purging»; la tarea lo retoma y lo cierra', async () => {
    await seedData(ORG_A, 'A', INSTANCE_A);
    await deleteCompany(ORG_A);
    await expire(ORG_A);
    const claimed = await store.claimDue(new Date(), 60_000);
    expect(claimed?.organizationId).toBe(ORG_A);
    for (let i = 0; i < 30; i++) if ((await store.step(ORG_A)).every((r) => r.deleted === 0)) break;
    await store.identity(ORG_A); // y el proceso muere aquí
    expect(await orgRow(ORG_A)).toMatchObject({ status: 'purged' });
    expect(await deletion(ORG_A)).toMatchObject({ state: 'purging' });
    expect(await run()).toBe(0); // mientras el arrendamiento vale, nadie más lo toma
    await admin.query(`UPDATE organization_deletions SET purge_lease_until = now() - interval '1 minute' WHERE organization_id = $1`, [ORG_A]);
    await run();
    expect(await deletion(ORG_A)).toMatchObject({ state: 'purged', purge_attempts: 2 });
    expect(await audits('company.purged')).toHaveLength(1);
  });

  it('dos tareas a la vez no borran dos veces (SKIP LOCKED + arrendamiento)', async () => {
    await seedData(ORG_A, 'A', INSTANCE_A, 6);
    await deleteCompany(ORG_A);
    await expire(ORG_A);
    const [x, y] = await Promise.all([run(), run()]);
    expect(x + y).toBeGreaterThan(0);
    expect(await deletion(ORG_A)).toMatchObject({ state: 'purged', purge_attempts: 1 });
    expect(await audits('company.purged')).toHaveLength(1);
    expect(await rowsOf(ORG_A)).toBe(0);
  });
});
