// V21 — Biblioteca de archivos (ADR-75). Rutas cubiertas (el registro de endpoints exige que este archivo las escriba tal cual):
//   GET /v1/library
//   GET /v1/library/usage
//   POST /v1/library/assets
//   PATCH /v1/library/assets/:id
//   POST /v1/library/assets/:id/archive
//   GET /v1/library/assets/:id/url
//   GET /v1/library/assets/:id/usage
//   POST /v1/library/folders
//   PATCH /v1/library/folders/:id
//   POST /v1/library/folders/:id/archive
//   PUT /v1/platform/companies/:id/storage-quota
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { EICAR, StorageGateway } from '../../src/modules/attachments';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { LibraryModule } from '../../src/modules/library';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, LibraryModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
  root: 'f0000000-0000-4000-8000-0000000000f1', // Súper Admin
};
const GB = 1024 * 1024 * 1024;

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let T: Record<'alice' | 'carol' | 'bob' | 'root', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE media_assets, media_folders, platform_audit, audit_logs, access_sessions, sessions, auth_throttle, trials, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', null]] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']] as const) {
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

const JPEG = (n = 404, fill = 5) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, fill)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 5)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(600, 7)]);

interface Asset { id: string; name: string; description: string | null; kind: string; mime_type: string; size_bytes: number; folder_id: string | null; usable_by_advisors: boolean; usable_by_ai: boolean; state: string; scan_status: string; archived_at: string | null }
interface Folder { id: string; name: string; asset_count: number }
interface Listing { folders: Folder[]; items: Asset[]; next_cursor: string | null; usage: { used_bytes: number; quota_bytes: number; available_bytes: number; assets: number } | null; access: { manage: boolean }; storage_available: boolean }

const upload = (token: string | null, bytes: Buffer, mime: string, filename = 'archivo', query = '') =>
  fetch(`${base}/library/assets${query}`, { method: 'POST', headers: { 'content-type': mime, 'x-filename': encodeURIComponent(filename), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: bytes });
const upOk = async (token: string, bytes: Buffer, mime: string, filename = 'archivo', query = ''): Promise<Asset> => {
  const r = await upload(token, bytes, mime, filename, query);
  expect(r.status, await r.clone().text()).toBe(201);
  return json<Asset>(r);
};
const list = (token: string, query = '') => call('GET', `/library${query}`, token).then((r) => json<Listing>(r));
const setQuota = (org: string, bytes: number) => admin.query(`UPDATE organizations SET storage_quota_bytes = $2 WHERE id = $1`, [org, bytes]);
const storage = () => app.get(StorageGateway);
const inOrg = <R,>(org: string, fn: () => Promise<R>): Promise<R> => TenantContext.run({ organizationId: org }, fn);
const rows = async (sql = 'SELECT * FROM media_assets ORDER BY created_at') => (await admin.query(sql)).rows as Array<Record<string, unknown>>;

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'REQUIRE_VIRUS_SCAN']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
});

describe('permisos', () => {
  it('sin sesión 401; el asesor solo ve y pide URL (lo demás 403); el administrador todo', async () => {
    const a = await upOk(T.alice, JPEG(), 'image/jpeg', 'foto.jpg');
    const f = (await json<Folder>(await call('POST', '/library/folders', T.alice, { name: 'Catálogos' })));
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/library'], ['GET', '/library/usage'], ['PATCH', `/library/assets/${a.id}`, { name: 'x' }], ['POST', `/library/assets/${a.id}/archive`], ['GET', `/library/assets/${a.id}/url`], ['GET', `/library/assets/${a.id}/usage`],
      ['POST', '/library/folders', { name: 'Y' }], ['PATCH', `/library/folders/${f.id}`, { name: 'Z' }], ['POST', `/library/folders/${f.id}/archive`],
    ];
    for (const [m, p, b] of routes) expect((await call(m, p, undefined, b)).status, `${m} ${p}`).toBe(401);
    expect((await upload(null, JPEG(), 'image/jpeg')).status).toBe(401);
    // el asesor: ver y URL sí; administrar no
    expect((await call('GET', '/library', T.carol)).status).toBe(200);
    expect((await call('GET', `/library/assets/${a.id}/url`, T.carol)).status).toBe(200);
    for (const [m, p, b] of routes.filter(([m, p]) => !(m === 'GET' && (p === '/library' || p.endsWith('/url'))))) expect((await call(m, p, T.carol, b)).status, `asesor ${m} ${p}`).toBe(403);
    expect((await upload(T.carol, JPEG(), 'image/jpeg')).status).toBe(403);
    expect((await call('GET', '/library/usage', T.alice)).status).toBe(200);
  });

  it('el asesor solo ve lo marcado para asesores y lo vigente; el administrador ve todo y también los archivados; sin uso ni cuota para el asesor', async () => {
    const open = await upOk(T.alice, JPEG(404, 1), 'image/jpeg', 'abierto.jpg');
    const closed = await upOk(T.alice, JPEG(404, 2), 'image/jpeg', 'interno.jpg');
    const gone = await upOk(T.alice, JPEG(404, 3), 'image/jpeg', 'archivado.jpg');
    expect((await call('PATCH', `/library/assets/${closed.id}`, T.alice, { usable_by_advisors: false })).status).toBe(200);
    expect((await call('POST', `/library/assets/${gone.id}/archive`, T.alice)).status).toBe(200);
    const adv = await list(T.carol);
    expect(adv.items.map((i) => i.id)).toEqual([open.id]);
    expect(adv.usage).toBeNull();
    expect(adv.access).toEqual({ manage: false });
    expect((await list(T.carol, '?state=archived')).items.map((i) => i.id)).toEqual([open.id]); // un asesor no ve archivados aunque lo pida
    expect((await call('GET', `/library/assets/${closed.id}/url`, T.carol)).status).toBe(404);
    expect((await call('GET', `/library/assets/${gone.id}/url`, T.carol)).status).toBe(404);
    const adm = await list(T.alice);
    expect(new Set(adm.items.map((i) => i.id))).toEqual(new Set([open.id, closed.id]));
    expect((await list(T.alice, '?state=archived')).items.map((i) => i.id)).toEqual([gone.id]);
    expect(adm.usage).toMatchObject({ assets: 2, quota_bytes: GB });
    expect((await call('GET', `/library/assets/${gone.id}/url`, T.alice)).status).toBe(404); // un archivado ya no se entrega
  });
});

describe('aislamiento A↔B', () => {
  it('lo de A nunca aparece ni se toca desde B (404 uniforme), el objeto vive bajo la empresa y la base no lo muestra sin su organización', async () => {
    const f = await json<Folder>(await call('POST', '/library/folders', T.alice, { name: 'Productos' }));
    const a = await upOk(T.alice, JPEG(), 'image/jpeg', 'a.jpg', `?folder_id=${f.id}`);
    expect((await list(T.bob)).items).toEqual([]);
    expect((await list(T.bob)).folders).toEqual([]);
    expect((await call('GET', `/library/assets/${a.id}/url`, T.bob)).status).toBe(404);
    expect((await call('PATCH', `/library/assets/${a.id}`, T.bob, { name: 'robado' })).status).toBe(404);
    expect((await call('POST', `/library/assets/${a.id}/archive`, T.bob)).status).toBe(404);
    expect((await call('PATCH', `/library/folders/${f.id}`, T.bob, { name: 'robada' })).status).toBe(404);
    expect((await call('POST', `/library/folders/${f.id}/archive`, T.bob)).status).toBe(404);
    expect((await upload(T.bob, JPEG(), 'image/jpeg', 'b.jpg', `?folder_id=${f.id}`)).status).toBe(404); // ni subir a su carpeta
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ organization_id: ORG_A, name: 'a.jpg' });
    // el objeto está bajo la empresa A (a B nunca se le da su clave ni una URL: no encuentra el archivo)
    const key = `org/${ORG_A}/library/${a.id}`;
    expect((await inOrg(ORG_A, () => storage().get(key))).length).toBe(404);
    // RLS: sin organización activa la aplicación no ve nada; con la de B tampoco ve lo de A
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      for (const t of ['media_assets', 'media_folders']) expect((await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, `${t} sin org`).toBe(0);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
      for (const t of ['media_assets', 'media_folders']) expect((await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, `${t} con B`).toBe(0);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      expect((await c.query(`SELECT count(*)::int n FROM media_assets`)).rows[0].n).toBe(1);
      await expect(c.query(`INSERT INTO media_folders(organization_id, id, name) VALUES ('${ORG_B}', gen_random_uuid(), 'Intruso')`)).rejects.toThrow(/row-level security/);
      await c.query('ROLLBACK');
      // sin DELETE para la aplicación (se archiva)
      await expect(c.query('DELETE FROM media_assets')).rejects.toThrow(/permission denied/);
      await expect(c.query('DELETE FROM media_folders')).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });
});

describe('subida', () => {
  it('guarda con nombre limpio, tipo por contenido, suma de comprobación y descripción; la clave del almacenamiento y la URL no salen en la auditoría', async () => {
    const a = await upOk(T.alice, PDF, 'application/pdf', '../../etc/Catálogo 2026.pdf', '?description=Precios%20vigentes');
    expect(a).toMatchObject({ kind: 'document', mime_type: 'application/pdf', size_bytes: PDF.length, folder_id: null, usable_by_advisors: true, usable_by_ai: false, state: 'ready', scan_status: 'clean', description: 'Precios vigentes' });
    expect(a.name).not.toMatch(/[\\/]/);
    expect(a.name).toContain('Catálogo 2026.pdf');
    expect(JSON.stringify(a)).not.toContain('storage_key');
    expect(JSON.stringify(a)).not.toContain(`org/${ORG_A}`);
    const [row] = await rows();
    expect(row).toMatchObject({ storage_key: `org/${ORG_A}/library/${a.id}`, created_by: IDS.alice });
    expect(String(row!['checksum'])).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('GET', `/library/assets/${a.id}/url`, T.alice)).status).toBe(200);
    const audit = JSON.stringify((await admin.query(`SELECT field, old_value, new_value FROM audit_logs WHERE entity_type = 'media_asset'`)).rows);
    expect(audit).toContain('uploaded');
    expect(audit).not.toContain('library/');
    expect(audit).not.toContain('http');
    expect(audit).not.toContain('Catálogo');
  });

  it('el tipo se decide por el CONTENIDO; tipos que no se envían, vacío, virus y tamaño por tipo se rechazan sin guardar nada', async () => {
    expect((await upload(T.alice, PNG, 'image/jpeg')).status).toBe(422); // el contenido no corresponde al tipo
    expect((await upload(T.alice, Buffer.from('MZ'), 'application/x-msdownload')).status).toBe(415);
    expect((await upload(T.alice, Buffer.from('RIFFxxxxWEBPyyyy'), 'image/webp')).status).toBe(415); // sticker o imagen WebP: no es de la biblioteca
    expect((await upload(T.alice, Buffer.alloc(0), 'image/jpeg')).status).toBe(400);
    const big = await upload(T.alice, JPEG(6 * 1024 * 1024), 'image/jpeg');
    expect(big.status).toBe(413);
    expect((await json<{ error: { message: string } }>(big)).error.message).toMatch(/5 MB/);
    expect((await upload(T.alice, Buffer.from(EICAR, 'latin1'), 'application/pdf')).status).toBe(422);
    expect(await rows()).toEqual([]);
    expect(await rows(`SELECT count(*)::int n FROM audit_logs WHERE entity_type = 'media_asset'`)).toEqual([{ n: 0 }]);
  });

  it('valida lo que va en la dirección: carpeta inexistente 404, nombre vacío o descripción de más 400', async () => {
    expect((await upload(T.alice, JPEG(), 'image/jpeg', 'a.jpg', '?folder_id=00000000-0000-4000-8000-000000000999')).status).toBe(404);
    expect((await upload(T.alice, JPEG(), 'image/jpeg', 'a.jpg', '?folder_id=no-es-uuid')).status).toBe(400);
    expect((await upload(T.alice, JPEG(), 'image/jpeg', 'a.jpg', `?description=${'x'.repeat(301)}`)).status).toBe(400);
    expect((await upload(T.alice, JPEG(), 'image/jpeg', 'a.jpg', '?otro=1')).status).toBe(400);
    expect(await rows()).toEqual([]);
  });
});

describe('cuota (el uso se deriva, el tope lo fija el Súper Admin)', () => {
  it('lo último que cabe pasa; lo que no cabe da 409 QUOTA_EXCEEDED sin guardar nada; archivar libera espacio; el uso sale de los archivos vigentes', async () => {
    await setQuota(ORG_A, 1000 * 2 + 10);
    const a = await upOk(T.alice, JPEG(1000, 1), 'image/jpeg', '1.jpg');
    await upOk(T.alice, JPEG(1000, 2), 'image/jpeg', '2.jpg');
    expect(await json(await call('GET', '/library/usage', T.alice))).toMatchObject({ used_bytes: 2000, quota_bytes: 2010, available_bytes: 10, assets: 2 });
    const over = await upload(T.alice, JPEG(1000, 3), 'image/jpeg', '3.jpg');
    expect(over.status).toBe(409);
    expect((await json<{ error: { code: string } }>(over)).error.code).toBe('QUOTA_EXCEEDED');
    expect(await rows()).toHaveLength(2);
    // el objeto de lo rechazado no queda suelto (el rechazo ocurre antes de guardarlo)
    expect((await call('POST', `/library/assets/${a.id}/archive`, T.alice)).status).toBe(200);
    expect(await json(await call('GET', '/library/usage', T.alice))).toMatchObject({ used_bytes: 1000, quota_bytes: 2010, available_bytes: 1010, assets: 1 });
    await upOk(T.alice, JPEG(1000, 3), 'image/jpeg', '3.jpg'); // ahora sí cabe
    // la cuota de A no afecta a B
    expect((await upload(T.bob, JPEG(1000, 4), 'image/jpeg', 'b.jpg')).status).toBe(201);
  });

  it('subidas simultáneas no pasan del tope: con lugar para dos, de cinco solo dos entran', async () => {
    await setQuota(ORG_A, 2 * 1004 + 100);
    const rs = await Promise.all([1, 2, 3, 4, 5].map((n) => upload(T.alice, JPEG(1004, n), 'image/jpeg', `${n}.jpg`)));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 201, 409, 409, 409]);
    expect(await rows()).toHaveLength(2);
    const stored = (await json<Listing>(await call('GET', '/library', T.alice))).usage!;
    expect(stored.used_bytes).toBeLessThanOrEqual(stored.quota_bytes);
  });

  it('el Súper Admin cambia el tope de una empresa (auditado en la plataforma); nadie más; bajarlo por debajo del uso no borra nada, solo frena las subidas nuevas', async () => {
    await upOk(T.alice, JPEG(1000, 1), 'image/jpeg', '1.jpg');
    expect((await call('PUT', `/platform/companies/${ORG_A}/storage-quota`, undefined, { storage_quota_bytes: 5000 })).status).toBe(401);
    expect((await call('PUT', `/platform/companies/${ORG_A}/storage-quota`, T.alice, { storage_quota_bytes: 5000 })).status).toBe(403);
    expect((await call('PUT', `/platform/companies/${ORG_A}/storage-quota`, T.carol, { storage_quota_bytes: 5000 })).status).toBe(403);
    for (const body of [{ storage_quota_bytes: -1 }, { storage_quota_bytes: 1.5 }, { storage_quota_bytes: 10_995_116_277_761 }, { storage_quota_bytes: '5000' }, {}, { storage_quota_bytes: 5000, otro: 1 }]) {
      expect((await call('PUT', `/platform/companies/${ORG_A}/storage-quota`, T.root, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call('PUT', `/platform/companies/${IDS.platformOrg}/storage-quota`, T.root, { storage_quota_bytes: 5000 })).status).toBe(404); // la plataforma no tiene biblioteca
    expect((await call('PUT', '/platform/companies/00000000-0000-4000-8000-000000000999/storage-quota', T.root, { storage_quota_bytes: 5000 })).status).toBe(404);
    const r = await call('PUT', `/platform/companies/${ORG_A}/storage-quota`, T.root, { storage_quota_bytes: 500 });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ id: ORG_A, storage_quota_bytes: 500 });
    expect((await rows(`SELECT storage_quota_bytes::text q FROM organizations WHERE id = '${ORG_A}'`))[0]).toEqual({ q: '500' });
    expect((await rows(`SELECT storage_quota_bytes::text q FROM organizations WHERE id = '${ORG_B}'`))[0]).toEqual({ q: String(GB) });
    const listed = await json<{ items: Array<{ id: string; storage_quota_bytes: number }> }>(await call('GET', '/platform/companies', T.root));
    expect(listed.items.find((c) => c.id === ORG_A)?.storage_quota_bytes).toBe(500); // la lista de la Consola muestra el tope
    expect(listed.items.find((c) => c.id === ORG_B)?.storage_quota_bytes).toBe(GB);
    const audit = await rows(`SELECT details FROM platform_audit WHERE action = 'company.storage_quota_changed'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]!['details']).toEqual({ from_bytes: GB, to_bytes: 500 });
    // el uso (1000) quedó sobre el tope (500): lo subido se sigue viendo y bajando, y solo se rechaza lo nuevo
    expect(await json(await call('GET', '/library/usage', T.alice))).toMatchObject({ used_bytes: 1000, quota_bytes: 500, available_bytes: 0, assets: 1 });
    expect((await list(T.alice)).items).toHaveLength(1);
    expect((await upload(T.alice, JPEG(404), 'image/jpeg', 'nueva.jpg')).status).toBe(409);
  });
});

describe('administrar archivos y carpetas', () => {
  it('cambia nombre, descripción, carpeta y usos (auditado); no cambia el contenido; la carpeta destino debe existir; mover de vuelta a la raíz', async () => {
    const f = await json<Folder>(await call('POST', '/library/folders', T.alice, { name: 'Servicios' }));
    const a = await upOk(T.alice, JPEG(), 'image/jpeg', 'a.jpg');
    const r = await call('PATCH', `/library/assets/${a.id}`, T.alice, { name: 'Corte clásico', description: 'Foto del corte', folder_id: f.id, usable_by_advisors: false, usable_by_ai: true });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ name: 'Corte clásico', description: 'Foto del corte', folder_id: f.id, usable_by_advisors: false, usable_by_ai: true, size_bytes: a.size_bytes, mime_type: 'image/jpeg' });
    expect((await call('PATCH', `/library/assets/${a.id}`, T.alice, { folder_id: '00000000-0000-4000-8000-000000000999' })).status).toBe(404);
    expect((await call('PATCH', `/library/assets/${a.id}`, T.alice, { folder_id: null })).status).toBe(200);
    expect((await list(T.alice, '?folder_id=root')).items.map((i) => i.id)).toEqual([a.id]);
    for (const body of [{}, { kind: 'video' }, { mime_type: 'x/y' }, { name: '' }, { name: 'x'.repeat(201) }, { storage_key: 'org/x' }]) expect((await call('PATCH', `/library/assets/${a.id}`, T.alice, body)).status, JSON.stringify(body)).toBe(400);
    const fields = (await rows(`SELECT field FROM audit_logs WHERE entity_type = 'media_asset' AND entity_id = '${a.id}'`)).map((x) => x['field']);
    expect(fields).toEqual(expect.arrayContaining(['uploaded', 'name', 'description', 'folder_id', 'usable_by_advisors', 'usable_by_ai']));
  });

  it('carpetas de un nivel: nombre único sin distinguir mayúsculas entre las vigentes, renombrar, contar archivos, no archivar con archivos y volver a usar el nombre de una archivada', async () => {
    const f = await json<Folder>(await call('POST', '/library/folders', T.alice, { name: 'Catálogos' }));
    expect((await call('POST', '/library/folders', T.alice, { name: 'catálogos' })).status).toBe(409);
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 'ok', padre: 1 }]) expect((await call('POST', '/library/folders', T.alice, body)).status, JSON.stringify(body)).toBe(400);
    const other = await json<Folder>(await call('POST', '/library/folders', T.alice, { name: 'Videos' }));
    expect((await call('PATCH', `/library/folders/${other.id}`, T.alice, { name: 'CATÁLOGOS' })).status).toBe(409);
    expect(await json(await call('PATCH', `/library/folders/${other.id}`, T.alice, { name: 'Videos cortos' }))).toMatchObject({ name: 'Videos cortos' });
    const a = await upOk(T.alice, PDF, 'application/pdf', 'precios.pdf', `?folder_id=${f.id}`);
    expect((await list(T.alice)).folders.map((x) => [x.name, x.asset_count])).toEqual([['Catálogos', 1], ['Videos cortos', 0]]);
    expect((await list(T.carol)).folders.map((x) => [x.name, x.asset_count])).toEqual([['Catálogos', 1], ['Videos cortos', 0]]); // el asesor ve los archivos para asesores
    const busy = await call('POST', `/library/folders/${f.id}/archive`, T.alice);
    expect(busy.status).toBe(409);
    expect((await json<{ error: { code: string } }>(busy)).error.code).toBe('FOLDER_NOT_EMPTY');
    expect((await call('POST', `/library/assets/${a.id}/archive`, T.alice)).status).toBe(200);
    expect((await call('POST', `/library/folders/${f.id}/archive`, T.alice)).status).toBe(200);
    expect((await call('POST', `/library/folders/${f.id}/archive`, T.alice)).status).toBe(404); // ya archivada
    expect((await upload(T.alice, JPEG(), 'image/jpeg', 'x.jpg', `?folder_id=${f.id}`)).status).toBe(404); // ni se sube a una archivada
    expect((await call('POST', '/library/folders', T.alice, { name: 'Catálogos' })).status).toBe(201); // el nombre queda libre
  });

  it('archivar conserva el objeto y la fila; archivar dos veces o uno ajeno es 404', async () => {
    const a = await upOk(T.alice, JPEG(), 'image/jpeg', 'a.jpg');
    expect((await call('POST', `/library/assets/${a.id}/archive`, T.alice)).status).toBe(200);
    expect((await call('POST', `/library/assets/${a.id}/archive`, T.alice)).status).toBe(404);
    expect((await call('PATCH', `/library/assets/${a.id}`, T.alice, { name: 'tarde' })).status).toBe(404);
    expect((await rows())[0]).toMatchObject({ state: 'archived' });
    expect((await rows())[0]!['archived_at']).not.toBeNull();
    expect((await inOrg(ORG_A, () => storage().get(`org/${ORG_A}/library/${a.id}`))).length).toBe(404); // el objeto sigue
    await expect(admin.query(`UPDATE media_assets SET state = 'ready'`)).rejects.toThrow(/media_assets_archived_consistent/);
  });
});

describe('listado', () => {
  it('filtra por carpeta, tipo y nombre (sin que un % o _ del texto sea comodín) y pagina con cursor', async () => {
    const f = await json<Folder>(await call('POST', '/library/folders', T.alice, { name: 'Fotos' }));
    const ids: string[] = [];
    for (const [n, name] of [[1, 'corte_1.jpg'], [2, 'corte%2.jpg'], [3, 'tinte.jpg'], [4, 'barba.jpg'], [5, 'peinado.jpg']] as const) {
      ids.push((await upOk(T.alice, JPEG(404, n), 'image/jpeg', name, n === 3 ? `?folder_id=${f.id}` : '')).id);
      await new Promise((r) => setTimeout(r, 5));
    }
    const pdf = await upOk(T.alice, PDF, 'application/pdf', 'catalogo.pdf');
    expect((await list(T.alice, '?kind=document')).items.map((i) => i.id)).toEqual([pdf.id]);
    expect((await list(T.alice, `?folder_id=${f.id}`)).items.map((i) => i.id)).toEqual([ids[2]]);
    expect((await list(T.alice, '?folder_id=root')).items).toHaveLength(5);
    expect((await list(T.alice, '?q=corte')).items.map((i) => i.name).sort()).toEqual(['corte%2.jpg', 'corte_1.jpg']);
    expect((await list(T.alice, '?q=%25')).items.map((i) => i.name)).toEqual(['corte%2.jpg']); // «%» es un carácter, no un comodín
    expect((await list(T.alice, '?q=_')).items.map((i) => i.name)).toEqual(['corte_1.jpg']);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page: Listing = await list(T.alice, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.items.map((x) => x.id));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect((await call('GET', '/library?cursor=basura', T.alice)).status).toBe(400);
    expect((await call('GET', '/library?limit=0', T.alice)).status).toBe(400);
    expect((await call('GET', '/library?kind=sticker', T.alice)).status).toBe(400);
  });
});

describe('URL firmada', () => {
  it('da una URL de pocos minutos; la auditoría guarda solo la primera por persona y archivo cada hora, sin la dirección', async () => {
    const a = await upOk(T.alice, JPEG(), 'image/jpeg', 'a.jpg');
    const r = await call('GET', `/library/assets/${a.id}/url`, T.alice);
    expect(r.status).toBe(200);
    const body = await json<{ url: string; expires_at: string; kind: string; name: string }>(r);
    expect(body.url).toMatch(/^https?:\/\//);
    expect(body).toMatchObject({ kind: 'image', name: 'a.jpg' });
    const ms = new Date(body.expires_at).getTime() - Date.now();
    expect(ms).toBeGreaterThan(200_000);
    expect(ms).toBeLessThanOrEqual(300_000);
    await call('GET', `/library/assets/${a.id}/url`, T.alice);
    await call('GET', `/library/assets/${a.id}/url`, T.alice);
    expect(await rows(`SELECT count(*)::int n FROM audit_logs WHERE entity_type = 'media_asset' AND field = 'url_issued'`)).toEqual([{ n: 1 }]);
    expect(JSON.stringify(await rows(`SELECT new_value FROM audit_logs WHERE field = 'url_issued'`))).not.toContain('http');
    expect((await call('GET', '/library/assets/no-es-uuid/url', T.alice)).status).toBe(400);
  });
});
