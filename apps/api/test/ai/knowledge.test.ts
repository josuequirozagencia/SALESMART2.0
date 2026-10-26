// M8.2 — Biblioteca de conocimiento y búsqueda (ADR-53; F16). Rutas cubiertas (el registro de endpoints exige que este archivo escriba cada una tal cual):
//   GET /v1/knowledge/documents
//   POST /v1/knowledge/documents
//   PATCH /v1/knowledge/documents/:id
//   POST /v1/knowledge/documents/:id/reprocess
//   DELETE /v1/knowledge/documents/:id
//   POST /v1/knowledge/search
//   GET /v1/platform/ai/models
//   PUT /v1/platform/ai/models/:model
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AI_PROVIDER, AiGateway, fromBytes, AiModule, AiProviderError, EMBEDDING_DIMENSIONS, FakeAiProvider, KNOWLEDGE_MAX_ATTEMPTS, KnowledgeJob, KnowledgeProcessorService, KnowledgeService, MAX_CHUNKS_PER_ORG, MAX_DOCUMENTS } from '../../src/modules/ai';
import { StorageGateway } from '../../src/modules/attachments';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { AiModelPricesService, AiPricingService } from '../../src/modules/platform';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';
import { makeDocx, makePdf } from './fixtures';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, AiModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const AG1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agencia
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let ai: FakeAiProvider;
let T: Record<'alice' | 'carol' | 'bob' | 'root', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE document_chunks, knowledge_documents, ai_holds, ai_ledger, ai_wallets, ai_org_pricing, platform_audit, audit_logs, access_sessions, sessions, auth_throttle, organization_members, organizations, users CASCADE');
  await admin.query(`UPDATE ai_pricing SET usd_per_credit = 0.01, global_margin_pct = 100`);
  await admin.query(`UPDATE ai_model_prices SET usd_per_1m_input = 0.02, usd_per_1m_output = 0 WHERE model = 'text-embedding-3-small'`);
  await admin.query(`UPDATE trial_config SET welcome_credits = 1000`);
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [AG1, 'agency', 'Agencia Uno']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.dave, 'dave@ag.test', 'Dave Agencia'], [IDS.root, 'root@plat.test', 'Raíz']] as const) {
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  }
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.dave, AG1, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']] as const) {
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
const upload = (token: string | undefined, bytes: Buffer, filename: string | null = 'horarios.txt') =>
  fetch(`${base}/knowledge/documents`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(filename ? { 'x-filename': encodeURIComponent(filename) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: new Uint8Array(bytes) });
const up = async (token: string, text: string, filename?: string): Promise<Row> => {
  const r = await upload(token, Buffer.from(text, 'utf8'), filename);
  expect(r.status, `subir ${filename}`).toBe(201);
  return json<Row>(r);
};
const docs = (token: string, qs = '') => call('GET', `/knowledge/documents${qs}`, token).then((r) => json<{ items: Row[]; next_cursor: string | null; limits: Row }>(r));
const search = (token: string, query: string, limit?: number) => call('POST', '/knowledge/search', token, { query, ...(limit ? { limit } : {}) });
const inOrg = <R,>(org: string, fn: () => Promise<R>): Promise<R> => TenantContext.run({ organizationId: org, userId: org === ORG_A ? IDS.alice : IDS.bob }, fn);
const run = (org = ORG_A, ahead = 1_000) => inOrg(org, () => app.get(KnowledgeProcessorService).runDue(new Date(Date.now() + ahead)));
const docRow = async (id: string) => (await admin.query(`SELECT * FROM knowledge_documents WHERE id = $1`, [id])).rows[0] as Row;
const chunksOf = async (id: string) => (await admin.query(`SELECT * FROM document_chunks WHERE document_id = $1 ORDER BY ordinal`, [id])).rows as Row[];
const ledger = async (org = ORG_A) => (await admin.query(`SELECT * FROM ai_ledger WHERE organization_id = $1 ORDER BY created_at, id`, [org])).rows as Row[];
const balance = async (org = ORG_A): Promise<number> => ((await admin.query(`SELECT balance_cache FROM ai_wallets WHERE organization_id = $1`, [org])).rows[0]?.balance_cache as number | undefined) ?? -1;
const setPrice = async (usdPer1m: number) => {
  await admin.query(`UPDATE ai_model_prices SET usd_per_1m_input = $1 WHERE model = 'text-embedding-3-small'`, [usdPer1m]);
  app.get(AiModelPricesService).invalidate();
};

const HORARIOS = 'Nuestro horario de atención es de lunes a viernes de 9 a 18 horas. Los sábados atendemos hasta el mediodía.';
const PRECIOS = 'El precio del corte de cabello es 10 dólares. El tinte cuesta 35 dólares y el peinado 20 dólares.';

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'AI_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'http://localhost:5173', MAIL_PROVIDER: 'console', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AI_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
  ai = app.get<FakeAiProvider>(AI_PROVIDER);
});
afterAll(async () => { await admin.query(`UPDATE trial_config SET welcome_credits = 1000`); await admin.query(`UPDATE ai_model_prices SET usd_per_1m_input = 0.02 WHERE model = 'text-embedding-3-small'`); await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  app.get(OrgDirectoryService).invalidate();
  app.get(AiPricingService).invalidate();
  app.get(AiModelPricesService).invalidate();
  ai.calls.length = 0;
  ai.keysSeen.length = 0;
  ai.requiresCredentials = false;
  ai.tokensPerInput = null;
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
});

describe('subir documentos', () => {
  it('POST /knowledge/documents: guarda el archivo, queda «pendiente», se audita y nunca devuelve la clave del almacenamiento', async () => {
    const r = await upload(T.alice, Buffer.from(HORARIOS), 'Horarios de atención.txt');
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const d = await json<Row>(r);
    expect(d).toMatchObject({ name: 'Horarios de atención.txt', kind: 'txt', size_bytes: Buffer.byteLength(HORARIOS), status: 'pending', active: true, chunk_count: 0, error_code: null, can_reprocess: false });
    expect(Object.keys(d).sort()).toEqual(['active', 'can_reprocess', 'chunk_count', 'created_at', 'error_code', 'error_message', 'id', 'kind', 'name', 'size_bytes', 'status', 'updated_at']); // lista blanca
    const row = await docRow(d['id'] as string);
    expect(row['storage_key']).toBe(`org/${ORG_A}/knowledge/${(row['storage_key'] as string).split('/').pop()}`);
    expect((await app.get(StorageGateway).get(row['storage_key'] as string)).toString()).toBe(HORARIOS);
    expect(row['content_hash']).toMatch(/^[0-9a-f]{64}$/);
    const audit = (await admin.query(`SELECT actor_user_id, new_value FROM audit_logs WHERE entity_type = 'knowledge_document' AND entity_id = $1`, [d['id']])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: IDS.alice, new_value: { name: 'Horarios de atención.txt', kind: 'txt' } });
  });

  it('sin sesión 401; el asesor no administra el conocimiento (403); un archivo vacío es 400', async () => {
    expect((await upload(undefined, Buffer.from('hola'))).status).toBe(401);
    expect((await upload(T.carol, Buffer.from('hola'))).status).toBe(403);
    expect((await call('GET', '/knowledge/documents', T.carol)).status).toBe(403);
    expect((await call('POST', '/knowledge/search', T.carol, { query: 'hola' })).status).toBe(403);
    const empty = await upload(T.alice, Buffer.alloc(0));
    expect(empty.status).toBe(400);
    expect(await json(empty)).toMatchObject({ error: { code: 'DOCUMENT_EMPTY' } });
  });

  it('el tipo se decide por el CONTENIDO: se aceptan TXT, CSV, PDF y Word; se rechazan imágenes, ejecutables y archivos disfrazados (415)', async () => {
    for (const [bytes, name, kind] of [[Buffer.from('hola'), 'a.txt', 'txt'], [Buffer.from('a,b\n1,2'), 'b.csv', 'csv'], [makePdf('hola'), 'c.pdf', 'pdf'], [makeDocx('hola'), 'd.docx', 'docx']] as const) {
      const r = await upload(T.alice, bytes, name);
      expect(r.status, name).toBe(201);
      expect(await json(r)).toMatchObject({ kind });
    }
    for (const [bytes, name] of [[Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), 'foto.png'], [Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), 'virus.txt'], [makePdf('x'), 'carta.docx'], [makeDocx('x'), 'carta.zip'], [Buffer.from('texto'), 'macro.xlsm'], [Buffer.from('texto'), 'script.exe']] as const) {
      const r = await upload(T.alice, bytes, name);
      expect(r.status, name).toBe(415);
      expect(await json(r)).toMatchObject({ error: { code: 'DOCUMENT_UNSUPPORTED' } });
    }
    expect((await docs(T.alice)).items).toHaveLength(4);
  });

  it('más de 10 MB es 413 y no se guarda nada', async () => {
    const r = await upload(T.alice, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61), 'enorme.txt');
    expect(r.status).toBe(413);
    expect(await json(r)).toMatchObject({ error: { code: 'DOCUMENT_TOO_LARGE' } });
    expect((await docs(T.alice)).items).toHaveLength(0);
  });

  it('el mismo contenido no se sube dos veces (409), aunque cambie el nombre; en otra empresa sí; tras borrarlo se puede volver a subir', async () => {
    const a = await up(T.alice, HORARIOS, 'uno.txt');
    const dup = await upload(T.alice, Buffer.from(HORARIOS), 'otro-nombre.txt');
    expect(dup.status).toBe(409);
    const body = await json<{ error: { code: string; message: string } }>(dup);
    expect(body.error).toMatchObject({ code: 'DOCUMENT_EXISTS' });
    expect(body.error.message).toContain('uno.txt');
    expect((await upload(T.bob, Buffer.from(HORARIOS), 'uno.txt')).status).toBe(201);
    expect((await call('DELETE', `/knowledge/documents/${a['id'] as string}`, T.alice)).status).toBe(200);
    expect((await upload(T.alice, Buffer.from(HORARIOS), 'uno.txt')).status).toBe(201);
  });

  it('el antivirus bloquea un archivo infectado (422) y no queda guardado', async () => {
    const r = await upload(T.alice, Buffer.from(EICAR), 'prueba.txt');
    expect(r.status).toBe(422);
    expect(await json(r)).toMatchObject({ error: { code: 'ATTACHMENT_INFECTED' } });
    expect((await docs(T.alice)).items).toHaveLength(0);
  });

  it('el nombre viene de X-Filename, sin rutas; sin nombre se llama «documento»; hay un tope de documentos por empresa', async () => {
    const traversal = String((await up(T.alice, 'uno', '../../etc/passwd.txt'))['name']);
    expect(traversal).not.toMatch(/[\\/]/); // sin rutas
    expect(traversal.endsWith('passwd.txt')).toBe(true);
    expect((await upload(T.alice, Buffer.from('dos'), null).then((r) => json<Row>(r)))['name']).toBe('documento');
    await admin.query(`INSERT INTO knowledge_documents(id, organization_id, name, kind, size_bytes, content_hash, storage_key) SELECT gen_random_uuid(), $1, 'D' || g, 'txt', 1, lpad(g::text, 64, '0'), 'k' || g FROM generate_series(1, ${MAX_DOCUMENTS - 2}) g`, [ORG_A]);
    const over = await upload(T.alice, Buffer.from('uno más'), 'extra.txt');
    expect(over.status).toBe(409);
    expect(await json(over)).toMatchObject({ error: { code: 'DOCUMENT_LIMIT' } });
  });

  it('GET /knowledge/documents: lista los vigentes con sus límites, del más reciente al más antiguo y con cursor; cada empresa ve los suyos', async () => {
    for (const n of ['a', 'b', 'c']) await up(T.alice, `texto ${n}`, `${n}.txt`);
    await up(T.bob, 'de la otra', 'otra.txt');
    const first = await docs(T.alice, '?limit=2');
    expect(first.items.map((i) => i['name'])).toEqual(['c.txt', 'b.txt']);
    expect(first.limits).toMatchObject({ max_bytes: 10 * 1024 * 1024, max_documents: MAX_DOCUMENTS, kinds: ['txt', 'csv', 'pdf', 'docx'], chunks_used: 0, chunks_max: MAX_CHUNKS_PER_ORG });
    const second = await docs(T.alice, `?limit=2&cursor=${first.next_cursor}`);
    expect(second.items.map((i) => i['name'])).toEqual(['a.txt']);
    expect(second.next_cursor).toBeNull();
    expect((await docs(T.bob)).items.map((i) => i['name'])).toEqual(['otra.txt']);
    expect((await call('GET', '/knowledge/documents?cursor=mal', T.alice)).status).toBe(400);
  });
});

describe('procesar documentos', () => {
  it('un TXT pasa a «listo», guarda fragmentos con vectores NORMALIZADOS y cobra créditos con costo y margen', async () => {
    const d = await up(T.alice, `${HORARIOS}\n\n${PRECIOS}`, 'info.txt');
    expect(await run()).toBe(1);
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'ready', error_code: null, error_message: null, attempts: 1, processing_started_at: null });
    const chunks = await chunksOf(d['id'] as string);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect((await docRow(d['id'] as string))['chunk_count']).toBe(chunks.length);
    for (const c of chunks) {
      const e = fromBytes(c['embedding'] as Buffer);
      expect(e).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(Math.sqrt(e.reduce((n, x) => n + x * x, 0))).toBeCloseTo(1, 4);
    }
    // se vectorizó con el modelo y las dimensiones del ADR, y la clave de la plataforma no se mezcló con nada de la empresa
    expect(ai.calls.filter((c) => c.kind === 'embed')).toHaveLength(1);
    expect(ai.calls[0]).toMatchObject({ kind: 'embed', model: 'text-embedding-3-small', dimensions: EMBEDDING_DIMENSIONS });
    const use = (await ledger()).find((l) => l['kind'] === 'use')!;
    expect(use).toMatchObject({ credits: -1, ref: 'Documento: info.txt' }); // a 0,02 USD por millón de tokens el costo es ínfimo: 1 crédito (el mínimo)
    expect(Number(use['cost_usd'])).toBeGreaterThan(0);
    expect(Number(use['margin_pct'])).toBe(100);
    expect(await balance()).toBe(999); // 1000 de bienvenida menos 1
    const listed = (await docs(T.alice)).items[0]!;
    expect(listed).toMatchObject({ status: 'ready', can_reprocess: true });
    expect((await docs(T.alice)).limits).toMatchObject({ chunks_used: chunks.length });
  });

  it('el costo sale del precio del modelo y los tokens que informa el proveedor; se reserva el peor caso y se cobra lo usado', async () => {
    await setPrice(5000); // 5 000 USD por millón de tokens: un fragmento de ≈ 250 tokens cuesta ≈ 1,25 USD
    const text = 'palabra '.repeat(125).trim(); // 999 caracteres ≈ 250 tokens para el fake (1 por cada 4 caracteres)
    const d = await up(T.alice, text, 'largo.txt');
    expect(await run()).toBe(1);
    const row = await docRow(d['id'] as string);
    expect(row['status']).toBe('ready');
    const tokens = (await chunksOf(d['id'] as string)).reduce((n, c) => n + Math.ceil((c['content'] as string).length / 4), 0); // el fake cuenta un token por cada 4 caracteres de cada fragmento
    const costUsd = (tokens * 5000) / 1_000_000;
    const expectedCredits = Math.ceil((costUsd * 2) / 0.01 - 1e-9);
    const use = (await ledger()).find((l) => l['kind'] === 'use')!;
    expect(use['credits']).toBe(-expectedCredits);
    expect(Number(use['cost_usd'])).toBeCloseTo(costUsd, 5);
    expect(await balance()).toBe(1000 - expectedCredits);
    // ninguna reserva queda abierta
    expect((await admin.query(`SELECT count(*)::int AS n FROM ai_holds WHERE status = 'active'`)).rows[0].n).toBe(0);
  });

  it('CSV, PDF y Word se leen y quedan listos', async () => {
    const csv = await upload(T.alice, Buffer.from('Servicio;Precio\nCorte;10\nTinte;35'), 'precios.csv').then((r) => json<Row>(r));
    const pdf = await upload(T.alice, makePdf('Garantia de los productos: treinta dias'), 'garantia.pdf').then((r) => json<Row>(r));
    const docx = await upload(T.alice, makeDocx('Politica de devoluciones', 'Se aceptan hasta 30 dias'), 'politica.docx').then((r) => json<Row>(r));
    expect(await run()).toBe(3);
    for (const d of [csv, pdf, docx]) expect(await docRow(d['id'] as string), String(d['name'])).toMatchObject({ status: 'ready' });
    expect((await chunksOf(csv['id'] as string))[0]!['content']).toBe('Servicio: Corte; Precio: 10\nServicio: Tinte; Precio: 35');
    expect((await chunksOf(pdf['id'] as string)).map((c) => c['content']).join(' ')).toContain('Garantia de los productos');
    expect((await chunksOf(docx['id'] as string)).map((c) => c['content']).join(' ')).toContain('Se aceptan hasta 30 dias');
  });

  it('un documento ilegible queda en «error» con un motivo claro; «Reprocesar» no cobra si vuelve a fallar', async () => {
    const scanned = await upload(T.alice, makePdf(''), 'escaneado.pdf').then((r) => json<Row>(r));
    const broken = await upload(T.alice, Buffer.from('%PDF-1.4\nno es un pdf de verdad'), 'roto.pdf').then((r) => json<Row>(r));
    const emptyCsv = await upload(T.alice, Buffer.from('Solo;encabezado\n'), 'vacio.csv').then((r) => json<Row>(r));
    expect(await run()).toBe(3);
    expect(await docRow(scanned['id'] as string)).toMatchObject({ status: 'error', error_code: 'empty' });
    expect(String((await docRow(scanned['id'] as string))['error_message'])).toContain('escaneada');
    expect(await docRow(broken['id'] as string)).toMatchObject({ status: 'error', error_code: 'corrupt' });
    expect(await docRow(emptyCsv['id'] as string)).toMatchObject({ status: 'error', error_code: 'empty' });
    expect(ai.calls).toHaveLength(0); // nada llegó a la IA
    expect((await ledger()).filter((l) => l['kind'] === 'use')).toHaveLength(0); // y nada se cobró
    const listed = (await docs(T.alice)).items.find((i) => i['id'] === scanned['id'])!;
    expect(listed).toMatchObject({ status: 'error', error_code: 'empty', can_reprocess: true });
    expect((await call('POST', `/knowledge/documents/${scanned['id'] as string}/reprocess`, T.alice)).status).toBe(200);
    expect(await run()).toBe(1);
    expect(await docRow(scanned['id'] as string)).toMatchObject({ status: 'error', error_code: 'empty' });
  });

  it('sin créditos suficientes el documento queda en «error: no_credits» sin gastar nada; al regalar créditos, «Reprocesar» lo deja listo', async () => {
    await setPrice(5000);
    const d = await up(T.alice, 'palabra '.repeat(125).trim(), 'largo.txt');
    await admin.query(`INSERT INTO ai_wallets(id, organization_id, balance_cache) VALUES (gen_random_uuid(), $1, 10)`, [ORG_A]);
    await admin.query(`INSERT INTO ai_ledger(id, organization_id, kind, credits, balance_after, ref) VALUES (gen_random_uuid(), $1, 'welcome', 10, 10, 'x')`, [ORG_A]);
    expect(await run()).toBe(1);
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'error', error_code: 'no_credits' });
    expect(ai.calls).toHaveLength(0);
    expect(await balance()).toBe(10);
    expect((await admin.query(`SELECT count(*)::int AS n FROM ai_holds WHERE status = 'active'`)).rows[0].n).toBe(0);
    const g = await call('POST', `/platform/ai/organizations/${ORG_A}/grants`, T.root, { credits: 2000, note: 'Reposición' });
    expect(g.status).toBe(400); // falta la llave
    await fetch(`${base}/platform/ai/organizations/${ORG_A}/grants`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${T.root}`, 'idempotency-key': 'key-reposicion-01' }, body: JSON.stringify({ credits: 2000, note: 'Reposición' }) });
    expect((await call('POST', `/knowledge/documents/${d['id'] as string}/reprocess`, T.alice)).status).toBe(200);
    expect(await run()).toBe(1);
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'ready', error_code: null });
  });

  it('si la plataforma aún no tiene la clave de IA, el documento ESPERA sin gastar intentos ni créditos, y se procesa solo cuando ya hay clave', async () => {
    ai.requiresCredentials = true; // imita al adaptador real: sin clave guardada en Proveedores no habla con el proveedor
    const d = await up(T.alice, HORARIOS, 'espera.txt');
    expect(await run()).toBe(1);
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'pending', error_code: 'waiting', attempts: 0 });
    expect(String((await docRow(d['id'] as string))['error_message'])).toContain('configurado');
    expect(ai.calls).toHaveLength(0);
    expect(await run()).toBe(0); // todavía no le toca (espera 60 s)
    for (let i = 0; i < 8; i++) { await run(ORG_A, 61_000 * (i + 1)); }
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'pending', attempts: 0 }); // nunca se agotan los intentos esperando
    expect(await app.get(AiGateway).available()).toBe(false);
    ai.requiresCredentials = false;
    expect(await app.get(AiGateway).available()).toBe(true);
    expect(await run(ORG_A, 10 * 61_000)).toBe(1);
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'ready', error_code: null });
  });

  it('la clave de la plataforma rechazada deja el documento en «error» (sin culpar al cliente) y libera la reserva sin cobrar', async () => {
    const d = await up(T.alice, HORARIOS, 'rechazo.txt');
    ai.failNext(new AiProviderError('La clave no sirve', false, true));
    expect(await run()).toBe(1);
    const row = await docRow(d['id'] as string);
    expect(row).toMatchObject({ status: 'error', error_code: 'ai_unavailable' });
    expect(String(row['error_message'])).not.toMatch(/clave|openai|sk-/i);
    expect((await ledger()).filter((l) => l['kind'] === 'use')).toHaveLength(0);
    expect(await balance()).toBe(1000);
    expect((await admin.query(`SELECT status FROM ai_holds`)).rows.map((r) => r.status)).toEqual(['released']);
  });

  it('un fallo pasajero reintenta con espera creciente y, tras 5 intentos, queda en «error»', async () => {
    const d = await up(T.alice, HORARIOS, 'ocupado.txt');
    for (let i = 1; i < KNOWLEDGE_MAX_ATTEMPTS; i++) {
      ai.failNext(new AiProviderError('El servicio está ocupado', true));
      expect(await run(ORG_A, i * 11 * 60_000)).toBe(1);
      const r = await docRow(d['id'] as string);
      expect(r, `intento ${i}`).toMatchObject({ status: 'pending', attempts: i, error_code: null });
      expect(new Date(r['next_attempt_at'] as string).getTime()).toBeGreaterThan(Date.now() + 10_000);
    }
    ai.failNext(new AiProviderError('El servicio está ocupado', true));
    expect(await run(ORG_A, 60 * 60_000)).toBe(1);
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'error', error_code: 'ai_busy', attempts: KNOWLEDGE_MAX_ATTEMPTS });
    expect((await ledger()).filter((l) => l['kind'] === 'use')).toHaveLength(0);
  });

  it('un fallo pasajero que se arregla: el documento termina «listo» en el siguiente intento', async () => {
    const d = await up(T.alice, HORARIOS, 'luego.txt');
    ai.failNext(new AiProviderError('El servicio está ocupado', true));
    await run();
    expect(await run(ORG_A, 10_000)).toBe(0); // la espera (30 s tras el primer fallo) aún no pasó
    expect(await run(ORG_A, 20 * 60_000)).toBe(1);
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'ready', attempts: 2 });
  });

  it('si el archivo ya no está en el almacenamiento, el motivo es claro y no se cobra', async () => {
    const d = await up(T.alice, HORARIOS, 'perdido.txt');
    await app.get(StorageGateway).delete((await docRow(d['id'] as string))['storage_key'] as string);
    expect(await run()).toBe(1);
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'error', error_code: 'storage_missing' });
    expect(ai.calls).toHaveLength(0);
  });

  it('el tope de fragmentos de la empresa: un documento que lo pasaría queda en «error: limit»', async () => {
    const old = await up(T.alice, 'existente', 'viejo.txt');
    await admin.query(`UPDATE knowledge_documents SET status = 'ready' WHERE id = $1`, [old['id']]);
    await admin.query(`INSERT INTO document_chunks(id, organization_id, document_id, ordinal, content, embedding) SELECT gen_random_uuid(), $1, $2, g, 'c' || g, decode(repeat('0000803f' || repeat('00000000', 7), 1), 'hex') FROM generate_series(0, ${MAX_CHUNKS_PER_ORG - 1}) g`, [ORG_A, old['id']]);
    const d = await up(T.alice, HORARIOS, 'nuevo.txt');
    expect(await run()).toBe(1);
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'error', error_code: 'limit' });
    expect(String((await docRow(d['id'] as string))['error_message'])).toContain('5.000');
    expect(ai.calls).toHaveLength(0);
  });

  it('un documento «procesando» con el arrendamiento vencido (el proceso murió) se retoma; uno reciente no se toca', async () => {
    const stuck = await up(T.alice, HORARIOS, 'colgado.txt');
    const fresh = await up(T.alice, PRECIOS, 'reciente.txt');
    await admin.query(`UPDATE knowledge_documents SET status = 'processing', processing_started_at = now() - interval '20 minutes' WHERE id = $1`, [stuck['id']]);
    await admin.query(`UPDATE knowledge_documents SET status = 'processing', processing_started_at = now() WHERE id = $1`, [fresh['id']]);
    expect(await run()).toBe(1);
    expect(await docRow(stuck['id'] as string)).toMatchObject({ status: 'ready' });
    expect(await docRow(fresh['id'] as string)).toMatchObject({ status: 'processing' });
  });

  it('CONCURRENCIA: dos pasadas a la vez no procesan dos veces el mismo documento ni lo cobran dos veces', async () => {
    const d = await up(T.alice, HORARIOS, 'una-vez.txt');
    const [a, b] = await Promise.all([run(), run()]);
    expect(a + b).toBe(1);
    expect(ai.calls.filter((c) => c.kind === 'embed')).toHaveLength(1);
    expect((await ledger()).filter((l) => l['kind'] === 'use')).toHaveLength(1);
    expect(await docRow(d['id'] as string)).toMatchObject({ status: 'ready', attempts: 1 });
  });

  it('la tarea periódica recorre las empresas CLIENTE (no las agencias) y procesa cada documento bajo SU empresa', async () => {
    const a = await up(T.alice, HORARIOS, 'a.txt');
    const b = await up(T.bob, PRECIOS, 'b.txt');
    const n = await TenantContext.detach(() => app.get(KnowledgeJob).run(new Date(Date.now() + 1000)));
    expect(n).toBe(2);
    expect(await docRow(a['id'] as string)).toMatchObject({ status: 'ready', organization_id: ORG_A });
    expect(await docRow(b['id'] as string)).toMatchObject({ status: 'ready', organization_id: ORG_B });
    expect((await ledger(ORG_A)).filter((l) => l['kind'] === 'use')).toHaveLength(1);
    expect((await ledger(ORG_B)).filter((l) => l['kind'] === 'use')).toHaveLength(1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM ai_wallets WHERE organization_id = $1`, [AG1])).rows[0].n).toBe(0);
  });
});

describe('buscar en la biblioteca', () => {
  async function library(): Promise<{ horarios: Row; precios: Row }> {
    const horarios = await up(T.alice, HORARIOS, 'horarios.txt');
    const precios = await up(T.alice, PRECIOS, 'precios.txt');
    await run();
    return { horarios, precios };
  }

  it('POST /knowledge/search devuelve los fragmentos más parecidos con su documento y el parecido; cuesta un crédito de «prueba»', async () => {
    const { horarios, precios } = await library();
    const before = await balance();
    const r = await search(T.alice, '¿Cuál es el horario de atención de lunes a viernes?');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const { hits } = await json<{ hits: Array<{ document: { id: string; name: string }; content: string; score: number }> }>(r);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.document).toEqual({ id: horarios['id'], name: 'horarios.txt' });
    expect(hits[0]!.content).toContain('lunes a viernes');
    expect(hits[0]!.score).toBeGreaterThan(0.3);
    expect(hits[0]!.score).toBeLessThanOrEqual(1);
    expect(hits.every((h) => h.document.id !== precios['id'])).toBe(true);
    expect(Object.keys(hits[0]!).sort()).toEqual(['content', 'document', 'score']);
    expect(await balance()).toBe(before - 1);
    expect((await ledger()).filter((l) => l['kind'] === 'test')).toEqual([expect.objectContaining({ credits: -1, ref: 'Búsqueda en la biblioteca' })]);
    expect((await search(T.alice, 'precio del corte y del tinte', 1).then((x) => json<{ hits: unknown[] }>(x))).hits).toHaveLength(1);
  });

  it('SIN RESPALDO no hay resultados: una pregunta que no se parece a nada de la biblioteca devuelve una lista vacía (la base de «no inventar»)', async () => {
    await library();
    const r = await json<{ hits: unknown[] }>(await search(T.alice, 'receta de ceviche de camarón con limón'));
    expect(r.hits).toEqual([]);
    const empty = await TenantContext.detach(() => inOrg(ORG_B, () => app.get(KnowledgeService).search({ query: 'horario de atención' })));
    expect(empty.hits).toEqual([]); // una empresa sin documentos
  });

  it('solo cuentan los documentos LISTOS, ACTIVOS y vigentes: pendientes, con error, desactivados y borrados no aparecen', async () => {
    const { horarios, precios } = await library();
    const pending = await up(T.alice, 'El estacionamiento es gratuito para clientes todo el día', 'estacionamiento.txt');
    const q = 'horario de atención de lunes a viernes';
    expect((await json<{ hits: unknown[] }>(await search(T.alice, q))).hits.length).toBeGreaterThan(0);
    expect((await json<{ hits: unknown[] }>(await search(T.alice, 'estacionamiento gratuito para clientes'))).hits).toEqual([]); // aún pendiente
    // desactivar
    const off = await call('PATCH', `/knowledge/documents/${horarios['id'] as string}`, T.alice, { active: false });
    expect(off.status).toBe(200);
    expect(await json(off)).toMatchObject({ active: false });
    expect((await json<{ hits: unknown[] }>(await search(T.alice, q))).hits).toEqual([]);
    await call('PATCH', `/knowledge/documents/${horarios['id'] as string}`, T.alice, { active: true });
    expect((await json<{ hits: unknown[] }>(await search(T.alice, q))).hits.length).toBeGreaterThan(0);
    // borrar
    expect((await call('DELETE', `/knowledge/documents/${precios['id'] as string}`, T.alice)).status).toBe(200);
    expect((await json<{ hits: unknown[] }>(await search(T.alice, 'precio del corte de cabello'))).hits).toEqual([]);
    expect((await chunksOf(precios['id'] as string))).toHaveLength(0);
    void pending;
  });

  it('A↔B: nunca aparece un fragmento de otra empresa, ni siquiera pidiendo su documento por id', async () => {
    await library();
    const otro = await up(T.bob, 'El horario secreto de la otra empresa es de lunes a viernes de 7 a 15', 'secreto.txt');
    await run(ORG_B);
    const mine = await json<{ hits: Array<{ document: { name: string }; content: string }> }>(await search(T.alice, 'horario de lunes a viernes'));
    expect(mine.hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine)).not.toContain('secreto');
    const theirs = await json<{ hits: Array<{ document: { name: string } }> }>(await search(T.bob, 'horario de lunes a viernes'));
    expect(theirs.hits.map((h) => h.document.name)).toEqual(['secreto.txt']);
    // desde A, pedir buscar SOLO en el documento de B no encuentra nada
    const cross = await TenantContext.detach(() => inOrg(ORG_A, () => app.get(KnowledgeService).search({ query: 'horario secreto de lunes a viernes', documentIds: [otro['id'] as string] })));
    expect(cross.hits).toEqual([]);
  });

  it('acotar a documentos concretos (los de un agente) y límite de resultados', async () => {
    const { horarios, precios } = await library();
    const svc = app.get(KnowledgeService);
    const only = await TenantContext.detach(() => inOrg(ORG_A, () => svc.search({ query: 'horario de atención y precio del corte', documentIds: [precios['id'] as string] })));
    expect(only.hits.every((h) => h.document.id === precios['id'])).toBe(true);
    const none = await TenantContext.detach(() => inOrg(ORG_A, () => svc.search({ query: 'horario de atención', documentIds: [] })));
    expect(none.hits).toEqual([]);
    void horarios;
  });

  it('validación y errores: pregunta vacía o demasiado larga (400), sin créditos (409), IA no configurada o caída (5xx claros) sin cobrar', async () => {
    await library();
    for (const bad of [{ query: '' }, { query: '   ' }, { query: 'x'.repeat(2001) }, {}, { query: 'a', limit: 0 }, { query: 'a', limit: 11 }, { query: 'a', otro: 1 }]) {
      expect((await call('POST', '/knowledge/search', T.alice, bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    const before = await balance();
    ai.failNext(new AiProviderError('ocupado', true));
    expect((await search(T.alice, 'horario')).status).toBe(503);
    ai.failNext(new AiProviderError('clave', false, true));
    const rej = await search(T.alice, 'horario');
    expect(rej.status).toBe(502);
    expect(JSON.stringify(await json(rej))).not.toMatch(/clave|openai|sk-/i);
    ai.requiresCredentials = true;
    const nc = await search(T.alice, 'horario');
    expect(nc.status).toBe(503);
    expect(await json(nc)).toMatchObject({ error: { code: 'AI_NOT_CONFIGURED' } });
    ai.requiresCredentials = false;
    expect(await balance()).toBe(before); // ninguna búsqueda fallida cobró
    await admin.query(`UPDATE ai_wallets SET balance_cache = 0 WHERE organization_id = $1`, [ORG_A]);
    await admin.query(`INSERT INTO ai_ledger(id, organization_id, kind, credits, balance_after, ref) VALUES (gen_random_uuid(), $1, 'use', -${before}, 0, 'x')`, [ORG_A]);
    const none = await search(T.alice, 'horario');
    expect(none.status).toBe(409);
    expect(await json(none)).toMatchObject({ error: { code: 'AI_NO_CREDITS' } });
  });
});

describe('activar, renombrar, reprocesar y borrar', () => {
  it('PATCH: cambia el nombre (sin rutas) y activa o desactiva, auditado; no admite campos desconocidos ni un cuerpo vacío', async () => {
    const d = await up(T.alice, HORARIOS, 'viejo.txt');
    const id = d['id'] as string;
    const r = await call('PATCH', `/knowledge/documents/${id}`, T.alice, { name: '../Nuevo nombre.txt', active: false });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ name: '_Nuevo nombre.txt', active: false });
    const audit = (await admin.query(`SELECT field, old_value, new_value FROM audit_logs WHERE entity_id = $1 AND field IS NOT NULL ORDER BY field`, [id])).rows;
    expect(audit).toEqual([{ field: 'active', old_value: true, new_value: false }, { field: 'name', old_value: 'viejo.txt', new_value: '_Nuevo nombre.txt' }]);
    for (const bad of [{}, { otro: 1 }, { name: '' }, { active: 'si' }]) expect((await call('PATCH', `/knowledge/documents/${id}`, T.alice, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await call('PATCH', '/knowledge/documents/no-es-uuid', T.alice, { active: true })).status).toBe(400);
  });

  it('reprocesar un documento listo lo vuelve a procesar y reemplaza sus fragmentos; uno que está procesándose no se puede (409)', async () => {
    const d = await up(T.alice, HORARIOS, 'otra-vez.txt');
    const id = d['id'] as string;
    expect((await call('POST', `/knowledge/documents/${id}/reprocess`, T.alice)).status).toBe(409); // aún pendiente: ya está en fila
    await run();
    const first = (await chunksOf(id)).map((c) => c['id']);
    const r = await call('POST', `/knowledge/documents/${id}/reprocess`, T.alice);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ status: 'pending', can_reprocess: false });
    await run();
    const second = (await chunksOf(id)).map((c) => c['id']);
    expect(second).toHaveLength(first.length);
    expect(second).not.toEqual(first); // se escribieron de nuevo
    expect(await docRow(id)).toMatchObject({ status: 'ready', attempts: 1 });
    await admin.query(`UPDATE knowledge_documents SET status = 'processing' WHERE id = $1`, [id]);
    expect((await call('POST', `/knowledge/documents/${id}/reprocess`, T.alice)).status).toBe(409);
  });

  it('DELETE: borrado lógico, borra los fragmentos y el archivo, deja de listarse y queda auditado; borrar dos veces es 404', async () => {
    const d = await up(T.alice, HORARIOS, 'adios.txt');
    const id = d['id'] as string;
    await run();
    const key = (await docRow(id))['storage_key'] as string;
    const r = await call('DELETE', `/knowledge/documents/${id}`, T.alice);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ id, deleted: true });
    expect(await docRow(id)).toMatchObject({ active: false });
    expect((await docRow(id))['deleted_at']).not.toBeNull();
    expect(await chunksOf(id)).toHaveLength(0);
    await expect(app.get(StorageGateway).get(key)).rejects.toMatchObject({ code: 'not_found' });
    expect((await docs(T.alice)).items).toHaveLength(0);
    expect((await call('DELETE', `/knowledge/documents/${id}`, T.alice)).status).toBe(404);
    expect((await admin.query(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND field = 'deleted'`, [id])).rowCount).toBe(1);
  });

  it('A↔B: un documento de otra empresa es 404 para cambiar, reprocesar o borrar, y no se toca', async () => {
    const d = await up(T.bob, HORARIOS, 'de-b.txt');
    const id = d['id'] as string;
    await run(ORG_B);
    expect((await call('PATCH', `/knowledge/documents/${id}`, T.alice, { active: false })).status).toBe(404);
    expect((await call('POST', `/knowledge/documents/${id}/reprocess`, T.alice)).status).toBe(404);
    expect((await call('DELETE', `/knowledge/documents/${id}`, T.alice)).status).toBe(404);
    expect((await call('PATCH', `/knowledge/documents/11111111-1111-4111-8111-111111111111`, T.alice, { active: false })).status).toBe(404);
    expect(await docRow(id)).toMatchObject({ status: 'ready', active: true, deleted_at: null });
  });
});

describe('Súper Admin: precio de los modelos', () => {
  it('GET y PUT /platform/ai/models: solo el Súper Admin; valida, audita y el precio nuevo cambia el costo de lo siguiente', async () => {
    for (const t of [T.alice, T.carol]) {
      expect((await call('GET', '/platform/ai/models', t)).status).toBe(403);
      expect((await call('PUT', '/platform/ai/models/gpt-4o-mini', t, { usd_per_1m_input: '1', usd_per_1m_output: '1' })).status).toBe(403);
    }
    expect((await call('GET', '/platform/ai/models')).status).toBe(401);
    const list = await call('GET', '/platform/ai/models', T.root).then((r) => json<Array<Row>>(r));
    expect(list.map((m) => m['model'])).toEqual(['gpt-4o-mini', 'text-embedding-3-small']); // por tipo y nombre
    expect(list[1]).toMatchObject({ kind: 'embedding', usd_per_1m_input: '0.020000', usd_per_1m_output: '0.000000' });
    const ok = await call('PUT', '/platform/ai/models/text-embedding-3-small', T.root, { usd_per_1m_input: '5000', usd_per_1m_output: '0' });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ model: 'text-embedding-3-small', usd_per_1m_input: '5000.000000' });
    for (const bad of [{ usd_per_1m_input: '10001', usd_per_1m_output: '0' }, { usd_per_1m_input: '-1', usd_per_1m_output: '0' }, { usd_per_1m_input: 'x', usd_per_1m_output: '0' }, { usd_per_1m_input: '1' }, { usd_per_1m_input: '1', usd_per_1m_output: '1', otro: 1 }]) {
      expect((await call('PUT', '/platform/ai/models/text-embedding-3-small', T.root, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call('PUT', '/platform/ai/models/modelo-que-no-existe', T.root, { usd_per_1m_input: '1', usd_per_1m_output: '1' })).status).toBe(404);
    expect((await call('PUT', '/platform/ai/models/..%2Fx', T.root, { usd_per_1m_input: '1', usd_per_1m_output: '1' })).status).toBeGreaterThanOrEqual(400);
    const audit = (await admin.query(`SELECT details FROM platform_audit WHERE action = 'ai.model_price.update'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ model: 'text-embedding-3-small', before: { input: '0.020000' }, after: { input: '5000' } });
    // el precio nuevo vale para lo siguiente (sin esperar a que caduque la memoria)
    const d = await up(T.alice, 'palabra '.repeat(125).trim(), 'caro.txt');
    await run();
    expect(Number((await ledger()).find((l) => l['kind'] === 'use')!['credits'])).toBeLessThan(-100);
    void d;
  });
});

describe('permisos de la base de datos y restricciones', () => {
  it('los documentos no se borran (solo borrado lógico) y los fragmentos solo los toca app_rw; el precio de modelos es solo de plataforma', async () => {
    const as = async (url: string, sql: string) => {
      const c = new Client({ connectionString: url });
      await c.connect();
      try {
        return await c.query(sql);
      } finally {
        await c.end();
      }
    };
    await expect(as(info.rwUrl, 'DELETE FROM knowledge_documents')).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, 'TRUNCATE knowledge_documents')).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, 'UPDATE document_chunks SET ordinal = ordinal')).rejects.toThrow(/permission denied/);
    await expect(as(info.rwUrl, 'SELECT * FROM ai_model_prices')).rejects.toThrow(/permission denied/);
    for (const url of [info.platformUrl, info.identityUrl]) for (const t of ['knowledge_documents', 'document_chunks']) await expect(as(url, `SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
    await expect(as(info.identityUrl, 'SELECT * FROM ai_model_prices')).rejects.toThrow(/permission denied/);
    await expect(as(info.platformUrl, 'DELETE FROM ai_model_prices')).rejects.toThrow(/permission denied/);
  });

  it('las restricciones impiden filas incoherentes y referencias entre empresas', async () => {
    const d = await up(T.alice, HORARIOS, 'x.txt');
    const ins = (cols: string, vals: string) => admin.query(`INSERT INTO knowledge_documents(id, organization_id, ${cols}) VALUES (gen_random_uuid(), '${ORG_A}', ${vals})`);
    const base = (over: Record<string, string> = {}) => {
      const f = { name: `'n'`, kind: `'txt'`, size_bytes: '1', content_hash: `'${'a'.repeat(64)}'`, storage_key: `'k'`, status: `'pending'`, ...over };
      return [Object.keys(f).join(', '), Object.values(f).join(', ')] as const;
    };
    await expect(ins(...base({ kind: `'exe'` }))).rejects.toThrow(/knowledge_documents_kind_valid/);
    await expect(ins(...base({ status: `'raro'` }))).rejects.toThrow(/knowledge_documents_status_valid/);
    await expect(ins(...base({ content_hash: `'corto'` }))).rejects.toThrow(/knowledge_documents_hash_shape/);
    await expect(ins(...base({ size_bytes: '0' }))).rejects.toThrow(/knowledge_documents_size_valid/);
    await expect(ins(...base({ name: `'  '` }))).rejects.toThrow(/knowledge_documents_name_shape/);
    const chunk = (doc: string, org: string, emb: string) => admin.query(`INSERT INTO document_chunks(id, organization_id, document_id, ordinal, content, embedding) VALUES (gen_random_uuid(), '${org}', '${doc}', 0, 'x', ${emb})`);
    await expect(chunk(d['id'] as string, ORG_A, `decode('0000803f', 'hex')`)).rejects.toThrow(/document_chunks_embedding_len/);
    await expect(chunk(d['id'] as string, ORG_B, `decode(repeat('0000803f' || repeat('00000000', 7), 1), 'hex')`)).rejects.toThrow(/document_chunks_document_fk/); // el documento es de A
    await chunk(d['id'] as string, ORG_A, `decode(repeat('0000803f' || repeat('00000000', 7), 1), 'hex')`);
    await expect(chunk(d['id'] as string, ORG_A, `decode(repeat('0000803f' || repeat('00000000', 7), 1), 'hex')`)).rejects.toThrow(/document_chunks_doc_ordinal_uq/);
    await expect(admin.query(`UPDATE ai_model_prices SET usd_per_1m_input = 10001`)).rejects.toThrow(/ai_model_prices_price_valid/);
    await expect(admin.query(`INSERT INTO ai_model_prices(model, kind, usd_per_1m_input) VALUES ('../x', 'chat', 1)`)).rejects.toThrow(/ai_model_prices_model_shape/);
    await expect(admin.query(`INSERT INTO ai_model_prices(model, kind, usd_per_1m_input) VALUES ('ok-model', 'video', 1)`)).rejects.toThrow(/ai_model_prices_kind_valid/);
  });
});
