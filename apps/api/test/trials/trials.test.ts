// M1.5 — pruebas de 7 días, extensión única con aprobación, vencimiento (job con SKIP LOCKED) y cuenta en pausa.
// Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   GET /v1/trials/me                       (@SelfService: solo la organización del principal verificado)
//   POST /v1/trials/me/extension            (tenant + billing.manage; abierta con la cuenta en pausa)
//   GET /v1/platform/trials                 (Súper Admin)
//   POST /v1/platform/trials/:id/approve    (Súper Admin)
//   POST /v1/platform/trials/:id/deny       (Súper Admin)
import 'reflect-metadata';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uuidv7 } from '@sales-smart/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { JobRunner, JobsModule } from '../../src/jobs';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { FAKE_CAPTCHA_PASS, MAIL_PROVIDER, MemoryMailProvider } from '../../src/modules/auth/signup';
import { OrganizationsModule, TrialsService } from '../../src/modules/organizations';
import { RequirePermission } from '../../src/rbac';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, ORG_C, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

const DAY = 86_400_000;

@Controller('probe')
class ProbeController {
  /** Ruta de negocio cualquiera: con la cuenta en pausa debe responder 403 TRIAL_EXPIRED. */
  @RequirePermission('contacts.read')
  @Get('business')
  business() { return { ok: true }; }
}
@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, JobsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [ProbeController] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  carol: 'c0000000-0000-4000-8000-0000000000c3', // advisor de A
  root: 'f0000000-0000-4000-8000-0000000000f1', // super_admin
};
let admin: Client;
let hash = '';
const saved = { ...process.env };
interface Booted { app: INestApplication; base: string; mail: MemoryMailProvider; trials: TrialsService; jobs: JobRunner }
async function boot(env: Record<string, string> = {}): Promise<Booted> {
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', SIGNUP_IP_MAX_PER_HOUR: '200', SIGNUP_VERIFY_IP_MAX_PER_HOUR: '500', ...env });
  delete process.env['DATABASE_URL_OWNER'];
  const app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  return { app, base: `${await app.getUrl()}/v1`, mail: app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider, trials: app.get(TrialsService), jobs: app.get(JobRunner) };
}

async function seed() {
  await admin.query('TRUNCATE sessions, auth_throttle, email_verifications, signup_attempts, organization_members, organizations, users, audit_logs, platform_audit CASCADE'); // audit_logs/platform_audit son append-only para la app, pero el superusuario del test sí puede vaciarlas
  await admin.query(`UPDATE trial_config SET days = 7, extension_days = 3, retention_days = 30, welcome_credits = 1000`);
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Empresa A'], [ORG_B, 'client', 'Empresa B'], [ORG_C, 'client', 'Empresa C (sin prueba)']]) {
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  }
  const users: Array<[string, string]> = [[IDS.alice, 'alice@a.test'], [IDS.bob, 'bob@b.test'], [IDS.carol, 'carol@a.test'], [IDS.root, 'root@plat.test']];
  for (const [id, email] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, hash]);
  for (const [u, o, r] of [[IDS.alice, ORG_A, 'client_admin'], [IDS.bob, ORG_B, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.root, IDS.platformOrg, 'super_admin']]) {
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}

interface TrialSeed { org: string; owner: string; startedAgoDays?: number; endsInDays: number; status?: 'active' | 'expired'; ext?: 'none' | 'pending' | 'approved' | 'denied'; id?: string }
/** Inserta una prueba con fechas relativas a ahora (días, pueden ser negativos). */
async function trial(t: TrialSeed): Promise<string> {
  const id = t.id ?? uuidv7();
  const ext = t.ext ?? 'none';
  const status = t.status ?? 'active';
  const reason = ext === 'none' ? null : 'Necesitamos más tiempo para evaluar el producto';
  const decided = ext === 'approved' || ext === 'denied';
  await admin.query(
    `INSERT INTO trials(id, organization_id, owner_user_id, started_at, ends_at, status, expired_at, ext_status, ext_reason, ext_requested_at, ext_decided_by, ext_decided_at, ext_days_granted)
     VALUES ($1,$2,$3, now() - make_interval(days => $4), now() + make_interval(secs => $5), $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, t.org, t.owner, t.startedAgoDays ?? 10, t.endsInDays * 86400, status, status === 'expired' ? new Date() : null, ext, reason, ext === 'none' ? null : new Date(), decided ? IDS.root : null, decided ? new Date() : null, ext === 'approved' ? 3 : null],
  );
  return id;
}
const trialRow = async (id: string) => (await admin.query(`SELECT * FROM trials WHERE id = $1`, [id])).rows[0];

describe('pruebas gratuitas (M1.5)', () => {
  let b: Booted;
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    fetch(`${b.base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const login = async (email: string) => {
    const r = await call('POST', '/auth/login', undefined, { email, password: PW, token_transport: 'body' });
    expect(r.status).toBe(200);
    return ((await r.json()) as { access_token: string }).access_token;
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    hash = await new Argon2idHasher().hash(PW);
    b = await boot();
  });
  afterAll(async () => { await b.app.close(); await admin.end(); process.env = saved; });
  beforeEach(seed);

  // ── alta al verificar el correo ──────────────────────────────────────────────

  it('la prueba empieza al VERIFICAR el correo, con la duración de trial_config (no hardcodeada)', async () => {
    await admin.query(`UPDATE trial_config SET days = 5`);
    const reg = await call('POST', '/auth/signup', undefined, { email: 'nuevo@empresa.test', password: PW, organization_name: 'Mi Empresa SA', captcha_token: FAKE_CAPTCHA_PASS });
    expect(reg.status).toBe(202);
    expect((await admin.query(`SELECT count(*)::int AS n FROM trials`)).rows[0].n).toBe(0); // sin verificar: no hay prueba
    const code = b.mail.last('nuevo@empresa.test')!.code;
    expect((await call('POST', '/auth/verify', undefined, { email: 'nuevo@empresa.test', code })).status).toBe(200);
    const row = (await admin.query(`SELECT t.*, o.kind FROM trials t JOIN organizations o ON o.id = t.organization_id`)).rows;
    expect(row).toHaveLength(1);
    expect(row[0].kind).toBe('client');
    expect(row[0].status).toBe('active');
    expect(row[0].ext_status).toBe('none');
    expect(Math.round((row[0].ends_at.getTime() - row[0].started_at.getTime()) / DAY)).toBe(5);
    const token = await login('nuevo@empresa.test');
    const me = (await (await call('GET', '/trials/me', token)).json()) as { status: string; extension: { can_request: boolean } };
    expect(me.status).toBe('active');
    expect(me.extension.can_request).toBe(true);
  });

  // ── GET /trials/me ───────────────────────────────────────────────────────────

  it('GET /trials/me: cada organización ve SOLO la suya; sin sesión 401; el Súper Admin y una organización sin prueba reciben 404', async () => {
    await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 4 });
    await trial({ org: ORG_B, owner: IDS.bob, endsInDays: 1, ext: 'pending' });
    const a = (await (await call('GET', '/trials/me', await login('alice@a.test'))).json()) as { ends_at: string; extension: { status: string } };
    const bb = (await (await call('GET', '/trials/me', await login('bob@b.test'))).json()) as { ends_at: string; extension: { status: string } };
    expect(a.extension.status).toBe('none');
    expect(bb.extension.status).toBe('pending');
    expect(new Date(a.ends_at).getTime()).toBeGreaterThan(Date.now() + 3 * DAY);
    expect(new Date(bb.ends_at).getTime()).toBeLessThan(Date.now() + 2 * DAY);
    expect(JSON.stringify(a)).not.toMatch(/organization|owner|email|reason/i); // nada de otras cuentas ni de la decisión interna
    expect((await call('GET', '/trials/me')).status).toBe(401);
    expect((await call('GET', '/trials/me', await login('root@plat.test'))).status).toBe(404);
    // Un asesor también la ve (la pantalla de «vencida» es para todos los miembros)
    expect((await call('GET', '/trials/me', await login('carol@a.test'))).status).toBe(200);
  });

  it('GET /trials/me no admite ids ni organización de la petición: la respuesta sale siempre del principal', async () => {
    await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 4 });
    await trial({ org: ORG_B, owner: IDS.bob, endsInDays: 1 });
    const t = await login('alice@a.test');
    const mine = await (await call('GET', '/trials/me', t)).text();
    for (const q of [`?organization_id=${ORG_B}`, `?org=${ORG_B}`, `?id=${ORG_B}`]) {
      const r = await fetch(`${b.base}/trials/me${q}`, { headers: { authorization: `Bearer ${t}`, 'x-organization-id': ORG_B } });
      expect(await r.text()).toBe(mine);
    }
  });

  // ── cuenta en pausa ──────────────────────────────────────────────────────────

  it('vencida POR LA HORA (aunque el job no haya corrido): rutas de negocio 403 TRIAL_EXPIRED; sigue abierto lo que la pantalla de vencida necesita', async () => {
    await trial({ org: ORG_A, owner: IDS.alice, endsInDays: -1, status: 'active' }); // ends_at pasado, status aún 'active'
    const t = await login('alice@a.test');
    const biz = await call('GET', '/probe/business', t);
    expect(biz.status).toBe(403);
    expect(((await biz.json()) as { error: { code: string } }).error.code).toBe('TRIAL_EXPIRED');
    const me = (await (await call('GET', '/trials/me', t)).json()) as { status: string; extension: { can_request: boolean } };
    expect(me.status).toBe('expired');
    expect(me.extension.can_request).toBe(true);
    expect((await call('POST', '/trials/me/extension', t, { reason: 'Necesitamos más tiempo para evaluar el producto' })).status).toBe(202);
    const pw = await call('POST', '/auth/password', t, { current_password: PW, new_password: 'Otra-Clave-2026' });
    expect(pw.status).toBe(204); // @SelfService sigue funcionando
  });

  it('el estado materializado por el job también pausa; una prueba vigente o una organización sin prueba NO se pausan', async () => {
    await trial({ org: ORG_A, owner: IDS.alice, endsInDays: -2, status: 'expired' });
    await trial({ org: ORG_B, owner: IDS.bob, endsInDays: 3 });
    expect((await call('GET', '/probe/business', await login('alice@a.test'))).status).toBe(403);
    expect((await call('GET', '/probe/business', await login('bob@b.test'))).status).toBe(200);
    // ORG_C no tiene prueba (p. ej. cliente de pago futuro): nunca en pausa
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES (gen_random_uuid(),'dave@c.test',$1,'active',now())`, [hash]);
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),(SELECT id FROM users WHERE email='dave@c.test'),$1,'client_admin')`, [ORG_C]);
    expect((await call('GET', '/probe/business', await login('dave@c.test'))).status).toBe(200);
  });

  it('el pausado aplica en CADA petición: aprobar la extensión reabre la cuenta con el mismo token', async () => {
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: -1, ext: 'pending' });
    const t = await login('alice@a.test');
    expect((await call('GET', '/probe/business', t)).status).toBe(403);
    expect((await call('POST', `/platform/trials/${id}/approve`, await login('root@plat.test'))).status).toBe(200);
    expect((await call('GET', '/probe/business', t)).status).toBe(200);
  });

  // ── solicitar la extensión ───────────────────────────────────────────────────

  it('solicitar la extensión: 202, queda pending con el motivo; el asesor (sin billing.manage) recibe 403; sin sesión 401', async () => {
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 });
    const reason = 'Necesitamos más tiempo para evaluar el producto';
    expect((await call('POST', '/trials/me/extension', undefined, { reason })).status).toBe(401);
    expect((await call('POST', '/trials/me/extension', await login('carol@a.test'), { reason })).status).toBe(403);
    expect((await call('POST', '/trials/me/extension', await login('root@plat.test'), { reason })).status).toBe(403); // el Súper Admin no es un tenant
    const r = await call('POST', '/trials/me/extension', await login('alice@a.test'), { reason: `  ${reason}  ` });
    expect(r.status).toBe(202);
    expect(((await r.json()) as { extension: { status: string } }).extension.status).toBe('pending');
    const row = await trialRow(id);
    expect(row.ext_status).toBe('pending');
    expect(row.ext_reason).toBe(reason); // recortado
    expect(row.ext_requested_at).toBeInstanceOf(Date);
  });

  it('validación: motivo corto/largo/ausente, campos desconocidos y una organización en el cuerpo → 400 y NADA cambia', async () => {
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 });
    const t = await login('alice@a.test');
    for (const body of [{}, { reason: 'corto' }, { reason: 'x'.repeat(501) }, { reason: 123 }, { reason: 'Motivo suficientemente largo', organization_id: ORG_B }, { reason: 'Motivo suficientemente largo', extra: 1 }]) {
      expect((await call('POST', '/trials/me/extension', t, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await trialRow(id)).ext_status).toBe('none');
  });

  it('UNA sola extensión por cuenta: segunda solicitud 409 en pending, approved y denied; las demás organizaciones no se ven afectadas', async () => {
    const a = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 });
    const bId = await trial({ org: ORG_B, owner: IDS.bob, endsInDays: 2 });
    const t = await login('alice@a.test');
    const reason = 'Necesitamos más tiempo para evaluar el producto';
    expect((await call('POST', '/trials/me/extension', t, { reason })).status).toBe(202);
    const again = await call('POST', '/trials/me/extension', t, { reason });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('EXTENSION_ALREADY_USED');
    const root = await login('root@plat.test');
    await call('POST', `/platform/trials/${a}/deny`, root);
    expect((await call('POST', '/trials/me/extension', t, { reason })).status).toBe(409); // denegada: tampoco se puede volver a pedir
    // aprobada
    await admin.query(`TRUNCATE trials`);
    const a2 = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 });
    await call('POST', '/trials/me/extension', t, { reason });
    await call('POST', `/platform/trials/${a2}/approve`, root);
    expect((await call('POST', '/trials/me/extension', t, { reason })).status).toBe(409);
    // B sigue intacta y puede pedir la suya
    await admin.query(`TRUNCATE trials`);
    await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2, ext: 'denied' });
    const b2 = await trial({ org: ORG_B, owner: IDS.bob, endsInDays: 2, id: bId });
    expect((await call('POST', '/trials/me/extension', await login('bob@b.test'), { reason })).status).toBe(202);
    expect((await trialRow(b2)).ext_status).toBe('pending');
  });

  it('A↔B: la solicitud de A solo modifica la prueba de A', async () => {
    const a = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 });
    const bId = await trial({ org: ORG_B, owner: IDS.bob, endsInDays: 2 });
    await call('POST', '/trials/me/extension', await login('alice@a.test'), { reason: 'Necesitamos más tiempo para evaluar el producto' });
    expect((await trialRow(a)).ext_status).toBe('pending');
    expect((await trialRow(bId)).ext_status).toBe('none');
  });

  it('organización sin prueba: la solicitud devuelve 404 (no hay nada que extender)', async () => {
    expect((await call('POST', '/trials/me/extension', await login('alice@a.test'), { reason: 'Necesitamos más tiempo para evaluar el producto' })).status).toBe(404);
  });

  it('6 solicitudes SIMULTÁNEAS → exactamente una 202 y cinco 409', async () => {
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 });
    const t = await login('alice@a.test');
    const rs = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/trials/me/extension', t, { reason: 'Necesitamos más tiempo para evaluar el producto' })));
    expect(rs.map((r) => r.status).sort()).toEqual([202, 409, 409, 409, 409, 409]);
    expect((await trialRow(id)).ext_status).toBe('pending');
  });

  // ── consola de plataforma ────────────────────────────────────────────────────

  it('las rutas de plataforma exigen Súper Admin: sin sesión 401, tenant 403', async () => {
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2, ext: 'pending' });
    const t = await login('alice@a.test');
    for (const [m, p] of [['GET', '/platform/trials'], ['POST', `/platform/trials/${id}/approve`], ['POST', `/platform/trials/${id}/deny`]] as const) {
      expect((await call(m, p)).status, `${m} ${p} sin sesión`).toBe(401);
      expect((await call(m, p, t)).status, `${m} ${p} tenant`).toBe(403);
    }
    expect((await trialRow(id)).ext_status).toBe('pending');
  });

  it('listado: filtros, insignia de pendientes y paginación por cursor sin repetidos ni huecos', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES (gen_random_uuid(),'client',$1,'UTC')`, [`Cliente ${i}`]);
      const org = (await admin.query(`SELECT id FROM organizations WHERE name = $1`, [`Cliente ${i}`])).rows[0].id as string;
      ids.push(await trial({ org, owner: IDS.alice, endsInDays: i < 2 ? -1 : 3, ext: i === 0 || i === 3 ? 'pending' : 'none', status: i === 0 ? 'expired' : 'active' }));
    }
    const root = await login('root@plat.test');
    const get = async (qs = '') => (await (await call('GET', `/platform/trials${qs}`, root)).json()) as { items: Array<{ id: string; owner_email: string; organization_name: string; status: string; extension: { status: string; reason: string | null } }>; next_cursor: string | null; pending_extensions: number };

    const all = await get();
    expect(all.items).toHaveLength(5);
    expect(all.pending_extensions).toBe(2);
    expect(all.items[0]!.owner_email).toBe('alice@a.test');
    expect(all.items.map((i) => i.id)).toEqual([...ids].sort().reverse()); // más recientes (id v7) primero

    expect((await get('?extension=pending')).items).toHaveLength(2);
    expect((await get('?state=expired')).items).toHaveLength(2); // 0 (job) y 1 (por la hora)
    expect((await get('?state=active')).items).toHaveLength(3);
    expect((await get('?extension=pending&state=active')).items).toHaveLength(1);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const p: Awaited<ReturnType<typeof get>> = await get(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...p.items.map((i) => i.id));
      cursor = p.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all.items.map((i) => i.id));

    for (const bad of ['?limit=0', '?limit=101', '?limit=abc', '?cursor=no-es-uuid', '?extension=otro', '?state=otro', '?foo=1']) {
      expect((await call('GET', `/platform/trials${bad}`, root)).status, bad).toBe(400);
    }
  });

  it('aprobar ANTES de vencer SUMA los días al fin vigente (ADR-23 #4)', async () => {
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2, ext: 'pending' });
    const before = (await trialRow(id)).ends_at as Date;
    const r = await call('POST', `/platform/trials/${id}/approve`, await login('root@plat.test'));
    expect(r.status).toBe(200);
    const row = await trialRow(id);
    expect(row.ext_status).toBe('approved');
    expect(row.ext_days_granted).toBe(3);
    expect(row.ext_decided_by).toBe(IDS.root);
    expect(row.ends_at.getTime() - before.getTime()).toBe(3 * DAY);
    expect(row.status).toBe('active');
  });

  it('aprobar YA VENCIDA cuenta desde la aprobación y reactiva la cuenta (ADR-23 #4)', async () => {
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: -5, status: 'expired', ext: 'pending' });
    const t0 = Date.now();
    expect((await call('POST', `/platform/trials/${id}/approve`, await login('root@plat.test'))).status).toBe(200);
    const row = await trialRow(id);
    expect(row.status).toBe('active');
    expect(row.expired_at).toBeNull();
    const delta = row.ends_at.getTime() - t0;
    expect(delta).toBeGreaterThan(3 * DAY - 60_000);
    expect(delta).toBeLessThan(3 * DAY + 60_000);
  });

  it('los días concedidos salen de trial_config (no del código)', async () => {
    await admin.query(`UPDATE trial_config SET extension_days = 10`);
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 1, ext: 'pending' });
    const before = (await trialRow(id)).ends_at as Date;
    await call('POST', `/platform/trials/${id}/approve`, await login('root@plat.test'));
    expect((await trialRow(id)).ends_at.getTime() - before.getTime()).toBe(10 * DAY);
  });

  it('denegar no cambia el fin; después no se puede aprobar, denegar ni volver a pedir', async () => {
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2, ext: 'pending' });
    const before = (await trialRow(id)).ends_at as Date;
    const root = await login('root@plat.test');
    expect((await call('POST', `/platform/trials/${id}/deny`, root)).status).toBe(200);
    const row = await trialRow(id);
    expect(row.ext_status).toBe('denied');
    expect(row.ends_at.getTime()).toBe(before.getTime());
    expect(row.ext_days_granted).toBeNull();
    for (const a of ['approve', 'deny']) {
      const r = await call('POST', `/platform/trials/${id}/${a}`, root);
      expect(r.status, a).toBe(409);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe('EXTENSION_NOT_PENDING');
    }
    expect((await trialRow(id)).ext_status).toBe('denied');
  });

  it('decidir sobre una prueba inexistente → 404; sobre una sin solicitud → 409; id inválido → 400', async () => {
    const none = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2, ext: 'none' });
    const root = await login('root@plat.test');
    expect((await call('POST', `/platform/trials/${uuidv7()}/approve`, root)).status).toBe(404);
    expect((await call('POST', `/platform/trials/${none}/approve`, root)).status).toBe(409);
    expect((await call('POST', `/platform/trials/${none}/deny`, root)).status).toBe(409);
    expect((await call('POST', '/platform/trials/no-es-uuid/approve', root)).status).toBe(400);
    expect((await trialRow(none)).ext_status).toBe('none');
  });

  it('aprobar y denegar a la vez → exactamente una decisión gana', async () => {
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2, ext: 'pending' });
    const root = await login('root@plat.test');
    const rs = await Promise.all([...Array.from({ length: 4 }, () => call('POST', `/platform/trials/${id}/approve`, root)), ...Array.from({ length: 4 }, () => call('POST', `/platform/trials/${id}/deny`, root))]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    expect(['approved', 'denied']).toContain((await trialRow(id)).ext_status);
  });

  // ── auditoría ────────────────────────────────────────────────────────────────

  it('queda auditoría: la solicitud en audit_logs de la organización y las decisiones en platform_audit, sin el motivo', async () => {
    const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 });
    const reason = 'Necesitamos más tiempo para evaluar el producto';
    await call('POST', '/trials/me/extension', await login('alice@a.test'), { reason });
    const a = (await admin.query(`SELECT organization_id, entity_type, entity_id, field, actor_user_id, source, old_value, new_value FROM audit_logs`)).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ organization_id: ORG_A, entity_type: 'trial', entity_id: id, field: 'extension', actor_user_id: IDS.alice, source: 'manual', old_value: { status: 'none' }, new_value: { status: 'pending' } });
    expect(JSON.stringify(a)).not.toContain('evaluar');
    await call('POST', `/platform/trials/${id}/approve`, await login('root@plat.test'));
    const p = (await admin.query(`SELECT action, entity_type, entity_id, actor_user_id, target_org_id, details FROM platform_audit`)).rows;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ action: 'trial.extension_approved', entity_type: 'trial', entity_id: id, actor_user_id: IDS.root, target_org_id: ORG_A, details: { days_granted: 3 } });
    expect(JSON.stringify(p)).not.toContain('evaluar');
  });

  // ── garantías de la base de datos ────────────────────────────────────────────

  describe('base de datos: estado y transiciones', () => {
    const fails = async (sql: string, params: unknown[], re: RegExp) => { await expect(admin.query(sql, params)).rejects.toThrow(re); };

    it('CHECK: estados incoherentes de la extensión se rechazan (aprobada sin decisor, pendiente sin motivo, días sin aprobar…) aun con el trigger desactivado', async () => {
      const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 });
      // El trigger se dispara ANTES que los CHECK; para probar los CHECK por separado se desactivan los triggers de esta sesión (superusuario)
      const c = new Client({ connectionString: info.adminDbUrl });
      await c.connect();
      try {
        await c.query(`SET session_replication_role = replica`);
        const bad = async (sql: string, re: RegExp) => { await expect(c.query(sql, [id]), sql).rejects.toThrow(re); };
        await bad(`UPDATE trials SET ext_status='pending' WHERE id=$1`, /trials_ext_consistent/); // pendiente sin motivo
        await bad(`UPDATE trials SET ext_days_granted=3 WHERE id=$1`, /trials_ext_consistent/);
        await bad(`UPDATE trials SET ext_status='approved', ext_reason='Necesitamos más tiempo para evaluar', ext_requested_at=now() WHERE id=$1`, /trials_ext_consistent/); // aprobada sin decisor
        await bad(`UPDATE trials SET ext_status='otro' WHERE id=$1`, /trials_ext_(consistent|status_valid)/);
        await bad(`UPDATE trials SET status='expired' WHERE id=$1`, /trials_expired_consistent/); // vencida sin expired_at
        await bad(`UPDATE trials SET ends_at = started_at WHERE id=$1`, /trials_period_valid/);
        await bad(`UPDATE trials SET ext_status='pending', ext_reason='corto', ext_requested_at=now() WHERE id=$1`, /trials_ext_reason_len/);
      } finally {
        await c.end();
      }
    });

    it('TRIGGER: solo none → pending → approved|denied; nada se revierte ni se edita después (ni siquiera con superusuario)', async () => {
      const none = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2, ext: 'none' });
      const approved = await trial({ org: ORG_B, owner: IDS.bob, endsInDays: 2, ext: 'approved' });
      const denied = await trial({ org: ORG_C, owner: IDS.alice, endsInDays: 2, ext: 'denied' });
      // saltarse el estado pendiente
      await fails(`UPDATE trials SET ext_status='approved', ext_reason='Necesitamos más tiempo para evaluar', ext_requested_at=now(), ext_decided_by=$2, ext_decided_at=now(), ext_days_granted=3 WHERE id=$1`, [none, IDS.root], /transición de extensión no permitida \(none -> approved\)/);
      // volver atrás o cambiar de decisión
      await fails(`UPDATE trials SET ext_status='pending', ext_decided_by=NULL, ext_decided_at=NULL, ext_days_granted=NULL WHERE id=$1`, [approved], /approved -> pending/);
      await fails(`UPDATE trials SET ext_status='none', ext_reason=NULL, ext_requested_at=NULL, ext_decided_by=NULL, ext_decided_at=NULL, ext_days_granted=NULL WHERE id=$1`, [approved], /approved -> none/);
      await fails(`UPDATE trials SET ext_status='approved', ext_days_granted=3 WHERE id=$1`, [denied], /denied -> approved/);
      // editar una decisión sin cambiar de estado
      await fails(`UPDATE trials SET ext_days_granted=99 WHERE id=$1`, [approved], /no se modifican sin cambiar de estado/);
      await fails(`UPDATE trials SET ext_reason='Otro motivo distinto del original' WHERE id=$1`, [denied], /no se modifican sin cambiar de estado/);
      // campos inmutables
      await fails(`UPDATE trials SET organization_id=$2 WHERE id=$1`, [none, ORG_B], /inmutables/);
      await fails(`UPDATE trials SET started_at = started_at - interval '1 day' WHERE id=$1`, [none], /inmutables/);
      // lo permitido sí funciona
      await admin.query(`UPDATE trials SET ext_status='pending', ext_reason='Necesitamos más tiempo para evaluar', ext_requested_at=now() WHERE id=$1`, [none]);
      await admin.query(`UPDATE trials SET ends_at = ends_at + interval '1 day' WHERE id=$1`, [approved]); // el fin vigente sí se puede mover
    });

    it('una sola prueba por organización (UNIQUE)', async () => {
      await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 });
      await expect(trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 })).rejects.toThrow(/trials_org_uq/);
    });

    it('privilegios: app_identity SELECT/INSERT/UPDATE en trials y SOLO SELECT en trial_config; app_rw y app_platform sin acceso; nadie puede borrar', async () => {
      const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: 2 });
      const open = async (url: string) => { const c = new Client({ connectionString: url }); await c.connect(); return c; };
      const idc = await open(info.identityUrl);
      const rw = await open(info.rwUrl);
      const pl = await open(info.platformUrl);
      try {
        await expect(idc.query(`SELECT 1 FROM trials`)).resolves.toBeTruthy();
        await expect(idc.query(`UPDATE trials SET updated_at = now() WHERE id=$1`, [id])).resolves.toBeTruthy();
        await expect(idc.query(`SELECT days FROM trial_config`)).resolves.toBeTruthy();
        for (const q of ['DELETE FROM trials', 'TRUNCATE trials', 'UPDATE trial_config SET days = 1', 'INSERT INTO trial_config(id,days,extension_days,retention_days,welcome_credits) VALUES (false,1,1,1,1)', 'DELETE FROM trial_config', 'TRUNCATE trial_config']) {
          await expect(idc.query(q), q).rejects.toThrow(/permission denied/);
        }
        for (const [name, c] of [['app_rw', rw], ['app_platform', pl]] as const) {
          for (const q of ['SELECT 1 FROM trials', 'SELECT 1 FROM trial_config', 'INSERT INTO trials(id) VALUES (gen_random_uuid())', 'UPDATE trials SET status = status']) {
            await expect(c.query(q), `${name}: ${q}`).rejects.toThrow(/permission denied/);
          }
        }
      } finally {
        await Promise.all([idc.end(), rw.end(), pl.end()]);
      }
    });

    it('trial_config es de UNA sola fila con rangos válidos', async () => {
      expect((await admin.query(`SELECT count(*)::int AS n FROM trial_config`)).rows[0].n).toBe(1);
      await fails(`INSERT INTO trial_config(id,days,extension_days,retention_days,welcome_credits) VALUES (false,7,3,30,1000)`, [], /trial_config_singleton/);
      await fails(`UPDATE trial_config SET days = 0`, [], /trial_config_ranges/);
      await fails(`UPDATE trial_config SET welcome_credits = -1`, [], /trial_config_ranges/);
    });
  });

  // ── job de vencimiento (SKIP LOCKED) ─────────────────────────────────────────

  describe('job de vencimiento', () => {
    const states = async () => (await admin.query(`SELECT id, status, expired_at FROM trials`)).rows as Array<{ id: string; status: string; expired_at: Date | null }>;

    it('marca como vencidas SOLO las activas cuyo fin pasó; es idempotente', async () => {
      const due = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: -1 });
      const live = await trial({ org: ORG_B, owner: IDS.bob, endsInDays: 2 });
      const already = await trial({ org: ORG_C, owner: IDS.alice, endsInDays: -3, status: 'expired' });
      const before = (await trialRow(already)).expired_at as Date;
      expect(await b.jobs.runOnce('trial-expiry')).toBe(1);
      const s = Object.fromEntries((await states()).map((r) => [r.id, r]));
      expect(s[due]!.status).toBe('expired');
      expect(s[due]!.expired_at).toBeInstanceOf(Date);
      expect(s[live]!.status).toBe('active');
      expect((await trialRow(already)).expired_at.getTime()).toBe(before.getTime()); // no se reescribe
      expect(await b.jobs.runOnce('trial-expiry')).toBe(0);
    });

    it('lotes: con más vencidas que el tamaño del lote, vencen TODAS', async () => {
      for (let i = 0; i < 7; i++) {
        await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES (gen_random_uuid(),'client',$1,'UTC')`, [`C${i}`]);
        const org = (await admin.query(`SELECT id FROM organizations WHERE name=$1`, [`C${i}`])).rows[0].id as string;
        await trial({ org, owner: IDS.alice, endsInDays: -1 - i });
      }
      expect(await b.trials.expireDue(new Date(), 3)).toBe(7);
      expect((await states()).every((r) => r.status === 'expired')).toBe(true);
    });

    it('SKIP LOCKED: una prueba bloqueada por otra transacción se SALTA (el job no espera) y se vence en la siguiente vuelta', async () => {
      const locked = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: -1 });
      const free = await trial({ org: ORG_B, owner: IDS.bob, endsInDays: -1 });
      const other = new Client({ connectionString: info.adminDbUrl });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query(`SELECT 1 FROM trials WHERE id=$1 FOR UPDATE`, [locked]); // p. ej. el Súper Admin está decidiendo esta prueba
        const t0 = Date.now();
        expect(await b.trials.expireDue(new Date(), 10)).toBe(1); // solo la libre
        expect(Date.now() - t0).toBeLessThan(2000); // no se quedó esperando el bloqueo
        const s = Object.fromEntries((await states()).map((r) => [r.id, r.status]));
        expect(s[free]).toBe('expired');
        expect(s[locked]).toBe('active');
        await other.query('COMMIT');
      } finally {
        await other.end();
      }
      expect(await b.trials.expireDue(new Date(), 10)).toBe(1);
      expect((await trialRow(locked)).status).toBe('expired');
    });

    it('dos ejecuciones SIMULTÁNEAS reparten el trabajo sin duplicarlo ni perder ninguna', async () => {
      for (let i = 0; i < 12; i++) {
        await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES (gen_random_uuid(),'client',$1,'UTC')`, [`P${i}`]);
        const org = (await admin.query(`SELECT id FROM organizations WHERE name=$1`, [`P${i}`])).rows[0].id as string;
        await trial({ org, owner: IDS.alice, endsInDays: -1 });
      }
      const counts = await Promise.all([b.trials.expireDue(new Date(), 2), b.trials.expireDue(new Date(), 2), b.trials.expireDue(new Date(), 2)]);
      expect(counts.reduce((a, c) => a + c, 0)).toBe(12);
      expect((await states()).every((r) => r.status === 'expired')).toBe(true);
    });

    it('carrera con una aprobación: si la extensión mueve el fin, el job NO la vence', async () => {
      const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: -1, ext: 'pending' });
      const other = new Client({ connectionString: info.adminDbUrl });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query(`SELECT 1 FROM trials WHERE id=$1 FOR UPDATE`, [id]);
        await other.query(`UPDATE trials SET ends_at = now() + interval '3 days', ext_status='approved', ext_decided_by=$2, ext_decided_at=now(), ext_days_granted=3 WHERE id=$1`, [id, IDS.root]);
        expect(await b.trials.expireDue(new Date(), 10)).toBe(0); // bloqueada: se salta
        await other.query('COMMIT');
      } finally {
        await other.end();
      }
      expect(await b.trials.expireDue(new Date(), 10)).toBe(0); // ya no está vencida
      expect((await trialRow(id)).status).toBe('active');
    });

    it('vencida por el job y luego aprobada: vuelve a active con expired_at nulo', async () => {
      const id = await trial({ org: ORG_A, owner: IDS.alice, endsInDays: -1, ext: 'pending' });
      await b.jobs.runOnce('trial-expiry');
      expect((await trialRow(id)).status).toBe('expired');
      await call('POST', `/platform/trials/${id}/approve`, await login('root@plat.test'));
      const row = await trialRow(id);
      expect(row.status).toBe('active');
      expect(row.expired_at).toBeNull();
    });

    it('una tarea desconocida se rechaza', async () => {
      await expect(b.jobs.runOnce('no-existe')).rejects.toThrow(/tarea desconocida/);
    });
  });
});
