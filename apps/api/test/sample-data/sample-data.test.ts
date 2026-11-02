// M10.6 — Datos de ejemplo y «Primeros pasos» (ADR-56 B5). Rutas cubiertas (el registro de endpoints exige que este archivo las escriba tal cual):
//   GET /v1/onboarding
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AiModule } from '../../src/modules/ai';
import { AuthModule, LocalAccessResolver, orgReady } from '../../src/modules/auth';
import { MAIL_PROVIDER, MemoryMailProvider } from '../../src/modules/auth/signup';
import { OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { AiModelPricesService } from '../../src/modules/platform';
import { SampleDataModule, SampleDataService } from '../../src/modules/sample-data';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, AiModule, SampleDataModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // administradora de A
  carol: 'c0000000-0000-4000-8000-0000000000c3', // asesora de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // administrador de B
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let mail: MemoryMailProvider;
let samples: SampleDataService;
let T: Record<'alice' | 'carol' | 'bob' | 'root', string>;
const saved = { ...process.env };

async function seed(): Promise<void> {
  await admin.query('TRUNCATE form_submissions, form_fields, form_routes, forms, agent_channels, agent_documents, agents, automation_run_steps, automation_runs, automations, queue_distribution_state, queue_members, queues, channel_accounts, tasks, ai_holds, ai_ledger, ai_wallets, audit_logs, invitations, access_sessions, sessions, auth_throttle, trials, member_permissions, member_history, organization_ownership_history, organization_members, organizations, users CASCADE');
  await admin.query(`INSERT INTO ai_model_prices(model, kind, usd_per_1m_input, usd_per_1m_output) VALUES ('gpt-4o-mini', 'chat', 0.15, 0.6) ON CONFLICT (model) DO NOTHING`);
  app?.get(AiModelPricesService).invalidate();
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna']] as const) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  for (const [id, email, name] of [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.carol, 'carol@a.test', 'Carolina Vera'], [IDS.bob, 'bob@b.test', 'Beto Luna'], [IDS.root, 'root@plat.test', 'Root']] as const) {
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
/** Crea los ejemplos de la empresa como lo hace el alta: dentro de su contexto. */
const seedOrg = (org: string, owner: string) => TenantContext.run({ organizationId: org, userId: owner }, () => samples.ensure());
interface Step { id: string; label: string; done: boolean; to: string }
interface Onboarding { steps: Step[]; done: number; total: number; complete: boolean }
const onboarding = async (t: string): Promise<Onboarding> => json<Onboarding>(await call('GET', '/onboarding', t));
const count = async (table: string, org = ORG_A, where = 'true'): Promise<number> => Number((await admin.query(`SELECT count(*) FROM ${table} WHERE organization_id = $1 AND ${where}`, [org])).rows[0].count);
const seededAt = async (org = ORG_A): Promise<Date | null> => (await admin.query(`SELECT sample_seeded_at FROM organizations WHERE id = $1`, [org])).rows[0].sample_seeded_at as Date | null;
const waitFor = async (fn: () => Promise<boolean>, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('no ocurrió a tiempo');
};

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  for (const k of ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'STORAGE_PROVIDER', 'VIRUS_SCANNER', 'AUDIO_TRANSCODER', 'AI_PROVIDER']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', STORAGE_PROVIDER: 'fake', VIRUS_SCANNER: 'fake', AI_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
  mail = app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider;
  samples = app.get(SampleDataService);
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => {
  await seed();
  app.get(OrgDirectoryService).invalidate();
  mail.inviteOutbox.length = 0;
  T = { alice: await login('alice@a.test'), carol: await login('carol@a.test'), bob: await login('bob@b.test'), root: await login('root@plat.test') };
});

describe('qué se crea', () => {
  it('un departamento «General» con el dueño, un agente APAGADO sin conexión, una automatización PAUSADA que solo crea una tarea y un formulario en BORRADOR; todo marcado como ejemplo y la empresa marcada como hecha', async () => {
    expect(await seedOrg(ORG_A, IDS.alice)).toEqual({ complete: true });
    const q = (await admin.query(`SELECT id, name, is_sample, sample_key, distribution_on FROM queues WHERE organization_id = $1`, [ORG_A])).rows;
    expect(q).toEqual([{ id: expect.any(String), name: 'General', is_sample: true, sample_key: 'general', distribution_on: false }]);
    expect((await admin.query(`SELECT user_id, active FROM queue_members WHERE queue_id = $1`, [q[0].id])).rows).toEqual([{ user_id: IDS.alice, active: true }]);
    const a = (await admin.query(`SELECT name, active, is_sample, sample_key, personality FROM agents WHERE organization_id = $1`, [ORG_A])).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ name: 'Asistente de ejemplo', active: false, is_sample: true, sample_key: 'assistant' });
    expect(a[0].personality).toMatch(/sin inventar/);
    expect(await count('agent_channels')).toBe(0); // sin conexión
    const au = (await admin.query(`SELECT name, status, is_sample, trigger_type, actions FROM automations WHERE organization_id = $1`, [ORG_A])).rows;
    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({ status: 'paused', is_sample: true, trigger_type: 'contact_created' });
    expect((au[0].actions as Array<{ type: string }>).map((x) => x.type)).toEqual(['create_task']); // nada de mensajes
    const f = (await admin.query(`SELECT name, status, is_sample, sample_key FROM forms WHERE organization_id = $1`, [ORG_A])).rows;
    expect(f).toEqual([{ name: 'Formulario de ejemplo', status: 'draft', is_sample: true, sample_key: 'contact' }]);
    expect(await count('form_fields')).toBeGreaterThanOrEqual(3);
    expect(await seededAt()).not.toBeNull();
  });

  it('NO envía mensajes ni gasta créditos: ninguna fila de mensajes, ningún movimiento del libro de créditos y ninguna ejecución', async () => {
    await seedOrg(ORG_A, IDS.alice);
    expect(await count('ai_ledger')).toBe(0);
    expect(await count('automation_runs')).toBe(0);
    expect(Number((await admin.query(`SELECT count(*) FROM messages WHERE organization_id = $1`, [ORG_A])).rows[0].count)).toBe(0);
  });

  it('es IDEMPOTENTE (repetir no duplica nada) y lo que el cliente borra NO reaparece', async () => {
    await seedOrg(ORG_A, IDS.alice);
    await seedOrg(ORG_A, IDS.alice);
    expect([await count('queues'), await count('agents'), await count('automations'), await count('forms')]).toEqual([1, 1, 1, 1]);
    await admin.query(`UPDATE agents SET deleted_at = now() WHERE organization_id = $1`, [ORG_A]);
    await admin.query(`UPDATE queues SET deleted_at = now() WHERE organization_id = $1`, [ORG_A]);
    await seedOrg(ORG_A, IDS.alice);
    expect(await count('agents', ORG_A, 'deleted_at IS NULL')).toBe(0);
    expect(await count('queues', ORG_A, 'deleted_at IS NULL')).toBe(0);
  });

  it('si algo falta (se interrumpió) se completa sin duplicar lo ya creado; con una empresa que ya usa el mismo nombre, ese ejemplo se omite y no se le pisa nada', async () => {
    await admin.query(`INSERT INTO queues(id, organization_id, name) VALUES (gen_random_uuid(), $1, 'General')`, [ORG_A]); // el cliente ya tenía su «General»
    expect(await seedOrg(ORG_A, IDS.alice)).toEqual({ complete: true });
    expect(await count('queues')).toBe(1);
    expect((await admin.query(`SELECT is_sample FROM queues WHERE organization_id = $1`, [ORG_A])).rows).toEqual([{ is_sample: false }]); // sigue siendo suyo
    // y un ejemplo que faltara se completa al repetir (aquí: se borra la marca y un ejemplo)
    await admin.query(`UPDATE organizations SET sample_seeded_at = NULL WHERE id = $1`, [ORG_A]);
    await admin.query(`DELETE FROM form_fields WHERE organization_id = $1`, [ORG_A]);
    await admin.query(`DELETE FROM forms WHERE organization_id = $1`, [ORG_A]);
    expect(await seedOrg(ORG_A, IDS.alice)).toEqual({ complete: true });
    expect([await count('agents'), await count('automations'), await count('forms')]).toEqual([1, 1, 1]);
  });

  it('sin un modelo de IA disponible el agente no se puede crear: lo demás sí, la empresa NO se marca como hecha y se completa cuando haya modelo', async () => {
    await admin.query(`DELETE FROM ai_model_prices WHERE kind = 'chat'`);
    app.get(AiModelPricesService).invalidate();
    expect(await seedOrg(ORG_A, IDS.alice)).toEqual({ complete: false });
    expect([await count('queues'), await count('agents'), await count('automations'), await count('forms')]).toEqual([1, 0, 1, 1]);
    expect(await seededAt()).toBeNull();
    await admin.query(`INSERT INTO ai_model_prices(model, kind, usd_per_1m_input, usd_per_1m_output) VALUES ('gpt-4o-mini', 'chat', 0.15, 0.6)`);
    app.get(AiModelPricesService).invalidate();
    expect(await seedOrg(ORG_A, IDS.alice)).toEqual({ complete: true });
    expect([await count('queues'), await count('agents'), await count('automations'), await count('forms')]).toEqual([1, 1, 1, 1]);
  });

  it('A↔B: los ejemplos de una empresa no tocan a la otra (cada una con los suyos, mismas claves)', async () => {
    await seedOrg(ORG_A, IDS.alice);
    expect([await count('queues', ORG_B), await count('agents', ORG_B)]).toEqual([0, 0]);
    await seedOrg(ORG_B, IDS.bob);
    expect([await count('queues', ORG_A), await count('queues', ORG_B)]).toEqual([1, 1]);
    expect(await seededAt(ORG_B)).not.toBeNull();
  });
});

describe('el alta los crea sola', () => {
  it('al aceptar la invitación del dueño de una empresa nueva se crean los ejemplos (sin que la aceptación espere ni falle por ello)', async () => {
    const created = await call('POST', '/platform/companies', T.root, { name: 'Café Origen', owner_email: 'dueno@cafe.test', timezone: 'America/Guayaquil', country: 'EC' });
    expect(created.status).toBe(201);
    const orgId = (await json<{ company: { id: string } }>(created)).company.id;
    const url = mail.lastInvitation('dueno@cafe.test')!.inviteUrl;
    const token = new URL(url).hash.replace(/^#token=/, '');
    const r = await call('POST', '/auth/invitations/accept', undefined, { token, password: 'Nueva-Clave-2026', full_name: 'Dueño Café', phone: '+593987654321' });
    expect(r.status).toBe(200);
    await waitFor(async () => (await seededAt(orgId)) !== null);
    expect([await count('queues', orgId), await count('agents', orgId), await count('automations', orgId), await count('forms', orgId)]).toEqual([1, 1, 1, 1]);
    const owner = (await admin.query(`SELECT id FROM users WHERE email = 'dueno@cafe.test'`)).rows[0].id as string;
    expect((await admin.query(`SELECT user_id FROM queue_members WHERE organization_id = $1`, [orgId])).rows).toEqual([{ user_id: owner }]);
  });

  it('un fallo al crear los ejemplos no deshace el alta: el manejador registra el error y la persona queda dentro', async () => {
    const errors: unknown[] = [];
    orgReady.register(async () => { throw new Error('falla a propósito'); });
    await orgReady.emit({ organizationId: ORG_A, ownerUserId: IDS.alice }, (e) => errors.push(e));
    expect(errors).toHaveLength(1);
  });
});

describe('«Primeros pasos»', () => {
  it('401 sin sesión; el asesor y la plataforma reciben 403', async () => {
    expect((await call('GET', '/onboarding')).status).toBe(401);
    expect((await call('GET', '/onboarding', T.carol)).status).toBe(403);
    expect((await call('GET', '/onboarding', T.root)).status).toBe(403);
  });

  it('abrirlo crea los ejemplos si faltaban (el reintento del siguiente acceso) y muestra cinco pasos pendientes', async () => {
    expect(await count('queues')).toBe(0);
    const o = await onboarding(T.alice);
    expect(await count('queues')).toBe(1);
    expect(o).toMatchObject({ done: 1, total: 5, complete: false }); // la asesora Carolina ya es parte del equipo
    expect(o.steps.map((s) => [s.id, s.done])).toEqual([['channel', false], ['advisor', true], ['department', false], ['agent', false], ['form', false]]);
    expect(o.steps.map((s) => s.to)).toEqual(['/settings/connections', '/users', '/departments', '/agents', '/forms']);
  });

  it('se marcan solos con los datos reales: canal conectado, asesor en un departamento, agente revisado y formulario publicado', async () => {
    await onboarding(T.alice);
    await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'ghl', 'GoHighLevel')`, [ORG_A]);
    expect((await onboarding(T.alice)).steps.find((s) => s.id === 'channel')!.done).toBe(false); // el canal de GoHighLevel no cuenta
    await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'meta_cloud', 'Ventas')`, [ORG_A]);
    const q = (await admin.query(`SELECT id FROM queues WHERE organization_id = $1`, [ORG_A])).rows[0].id as string;
    await admin.query(`INSERT INTO queue_members(organization_id, queue_id, user_id, active, weight) VALUES ($1, $2, $3, true, 1)`, [ORG_A, q, IDS.carol]);
    await admin.query(`UPDATE agents SET personality = 'Otro texto', updated_at = now() + interval '1 minute' WHERE organization_id = $1`, [ORG_A]);
    await admin.query(`UPDATE forms SET status = 'published' WHERE organization_id = $1`, [ORG_A]);
    const o = await onboarding(T.alice);
    expect(o).toMatchObject({ done: 5, total: 5, complete: true });
  });

  it('borrar el agente de ejemplo cuenta como haberlo revisado; una invitación pendiente de asesor cuenta como «invitar»', async () => {
    await admin.query(`DELETE FROM organization_members WHERE user_id = $1`, [IDS.carol]);
    const before = await onboarding(T.alice);
    expect(before.steps.find((s) => s.id === 'advisor')!.done).toBe(false);
    const inv = await call('POST', '/users/invitations', T.alice, { email: 'nora@a.test', role: 'advisor' });
    expect([201, 404]).toContain(inv.status); // la ruta de equipo no está en este módulo de prueba
    await admin.query(`UPDATE agents SET deleted_at = now() WHERE organization_id = $1`, [ORG_A]);
    expect((await onboarding(T.alice)).steps.find((s) => s.id === 'agent')!.done).toBe(true);
  });

  it('A↔B: los pasos de una empresa no dependen de los datos de la otra', async () => {
    await onboarding(T.alice);
    await admin.query(`INSERT INTO channel_accounts(id, organization_id, provider, name) VALUES (gen_random_uuid(), $1, 'meta_cloud', 'De Luna')`, [ORG_B]);
    expect((await onboarding(T.alice)).steps.find((s) => s.id === 'channel')!.done).toBe(false);
    expect((await onboarding(T.bob)).steps.find((s) => s.id === 'channel')!.done).toBe(true);
    expect(await count('queues', ORG_B)).toBe(1); // el de Luna se creó en SU empresa
  });
});
