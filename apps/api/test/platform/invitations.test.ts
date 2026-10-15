// M2.3 — «Nueva empresa» con invitación al dueño (ADR-39, flujo F01). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   POST /v1/platform/companies · POST /v1/platform/companies/:id/invitation/resend
//   POST /v1/auth/invitations/preview · POST /v1/auth/invitations/accept
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uuidv7 } from '@sales-smart/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { MAIL_PROVIDER, MemoryMailProvider } from '../../src/modules/auth/signup';
import { OrganizationsModule } from '../../src/modules/organizations';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const NEW_PW = 'Nueva-Clave-2026';
const DAY = 86_400_000;
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  agencyOrg: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  carol: 'c0000000-0000-4000-8000-0000000000c3', // advisor de A
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agency
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
let admin: Client;
let hash = '';
const saved = { ...process.env };

interface Booted { app: INestApplication; base: string; mail: MemoryMailProvider }
const ENV_KEYS = ['FRONTEND_BASE_URL', 'MAIL_PROVIDER', 'CAPTCHA_PROVIDER', 'INVITATION_TTL_DAYS', 'INVITATION_RESEND_COOLDOWN_SECONDS', 'INVITATION_ATTEMPT_IP_MAX_PER_HOUR', 'INVITE_LINK_PATH'];
async function boot(env: Record<string, string>): Promise<Booted> {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, ...env });
  delete process.env['DATABASE_URL_OWNER'];
  const app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  return { app, base: `${await app.getUrl()}/v1`, mail: app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider };
}
const GENEROUS = { FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake', INVITATION_ATTEMPT_IP_MAX_PER_HOUR: '500' };

async function seed() {
  await admin.query('TRUNCATE sessions, auth_throttle, signup_attempts, trials, invitations, organization_members, organizations, users, plans, platform_audit CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [IDS.agencyOrg, 'agency', 'Agencia Demo']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const users: Array<[string, string]> = [[IDS.alice, 'alice@a.test'], [IDS.bob, 'bob@b.test'], [IDS.carol, 'carol@a.test'], [IDS.dave, 'dave@agencia.test'], [IDS.root, 'root@plat.test']];
  for (const [id, email] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, hash]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.dave, IDS.agencyOrg, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
}

interface CompanyOut { company: { id: string; name: string; kind: string; state: string; plan: { id: string; name: string } | null; timezone: string; country: string }; invitation: { email: string; expires_at: string; delivery: string; invite_url?: string } }
interface CompanyRow { id: string; state: string; owner_email: string | null; country: string | null; invitation: { email: string; expires_at: string; expired: boolean } | null; plan: { id: string } | null; users: number }
const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const codeOf = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
const scrub = (o: unknown) => JSON.stringify(o, (k, v) => (k === 'request_id' ? undefined : v));
const tokenOf = (url: string): string => new URL(url).hash.replace(/^#token=/, '');

describe('«Nueva empresa» e invitaciones', () => {
  let b: Booted;
  let rootToken = '';
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    fetch(`${b.base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  async function login(email: string, password = PW): Promise<string> {
    const r = await call('POST', '/auth/login', undefined, { email, password, token_transport: 'body' });
    expect(r.status, `login ${email}`).toBe(200);
    return ((await r.json()) as { access_token: string }).access_token;
  }
  const NEW_CO = { name: 'Café Origen', owner_email: 'dueno@cafe.test', timezone: 'America/Guayaquil', country: 'EC' };
  const create = (over: Record<string, unknown> = {}) => call('POST', '/platform/companies', rootToken, { ...NEW_CO, ...over });
  const preview = (token: string) => call('POST', '/auth/invitations/preview', undefined, { token });
  const accept = (token: string, body: Record<string, unknown> = {}) => call('POST', '/auth/invitations/accept', undefined, { token, password: NEW_PW, full_name: 'Dora Quinde', phone: '+593987654321', ...body });
  /** Crea una empresa por la API y devuelve el token de su invitación tomado del correo (modo normal: el enlace no viaja en la respuesta). */
  async function invited(over: Record<string, unknown> = {}): Promise<{ orgId: string; token: string; email: string }> {
    const r = await create(over);
    expect(r.status).toBe(201);
    const out = await json<CompanyOut>(r);
    const url = b.mail.lastInvitation(out.invitation.email)?.inviteUrl;
    expect(url, 'el correo de invitación debió enviarse').toBeTruthy();
    return { orgId: out.company.id, token: tokenOf(url!), email: out.invitation.email };
  }
  const companies = async (qs = '') => json<{ items: CompanyRow[] }>(await call('GET', `/platform/companies${qs}`, rootToken));

  beforeAll(async () => {
    admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    hash = await new Argon2idHasher().hash(PW);
    b = await boot(GENEROUS);
  });
  afterAll(async () => { await b.app.close(); await admin.end(); process.env = saved; });
  beforeEach(async () => {
    await seed();
    b.mail.inviteOutbox.length = 0;
    rootToken = await login('root@plat.test');
  });

  describe('acceso', () => {
    it('crear y reenviar: sin sesión 401; cliente, asesor y agencia 403; no cambia nada', async () => {
      const { orgId } = await invited();
      const before = (await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n;
      const tokens = [await login('alice@a.test'), await login('carol@a.test'), await login('dave@agencia.test')];
      const routes: Array<[string, string, unknown?]> = [['POST', '/platform/companies', NEW_CO], ['POST', `/platform/companies/${orgId}/invitation/resend`]];
      for (const [m, p, body] of routes) {
        expect((await call(m, p, undefined, body)).status, `${m} ${p} sin sesión`).toBe(401);
        for (const t of tokens) expect((await call(m, p, t, body)).status, `${m} ${p} no super_admin`).toBe(403);
      }
      expect((await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(before);
    });
  });

  describe('crear la empresa', () => {
    it('201: crea la organización cliente y la invitación en una transacción; el correo sale y el enlace NO viaja en la respuesta', async () => {
      const r = await create();
      expect(r.status).toBe(201);
      expect(r.headers.get('cache-control')).toBe('no-store');
      const out = await json<CompanyOut>(r);
      expect(out.company).toMatchObject({ name: 'Café Origen', kind: 'client', state: 'invited', plan: null, timezone: 'America/Guayaquil', country: 'EC' });
      expect(out.invitation).toMatchObject({ email: 'dueno@cafe.test', delivery: 'sent' });
      expect(out.invitation.invite_url).toBeUndefined();
      expect(JSON.stringify(out)).not.toMatch(/token/i);
      expect(Math.abs(new Date(out.invitation.expires_at).getTime() - (Date.now() + 7 * DAY))).toBeLessThan(60_000);

      const mail = b.mail.lastInvitation('dueno@cafe.test')!;
      expect(mail.organizationName).toBe('Café Origen');
      expect(mail.expiresInDays).toBe(7);
      expect(mail.inviteUrl).toMatch(/^https:\/\/app\.ejemplo\.test\/accept-invite#token=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

      const org = (await admin.query(`SELECT kind, status, country, timezone, plan_id FROM organizations WHERE id = $1`, [out.company.id])).rows[0];
      expect(org).toMatchObject({ kind: 'client', status: 'active', country: 'EC', timezone: 'America/Guayaquil', plan_id: null });
      const inv = (await admin.query(`SELECT email, role, token_hash, consumed_at, invited_by, sent_count FROM invitations WHERE organization_id = $1`, [out.company.id])).rows[0];
      expect(inv).toMatchObject({ email: 'dueno@cafe.test', role: 'client_admin', consumed_at: null, invited_by: IDS.root, sent_count: 1 });
      expect(inv.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(inv)).not.toContain(tokenOf(mail.inviteUrl).split('.')[1]); // el secreto no está en la base: solo su hash
      // sin miembros ni prueba hasta que el dueño acepte
      expect((await admin.query(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [out.company.id])).rows[0].n).toBe(0);
      expect((await admin.query(`SELECT count(*)::int AS n FROM trials WHERE organization_id = $1`, [out.company.id])).rows[0].n).toBe(0);
    });

    it('la auditoría de plataforma registra company.created sin token ni enlace', async () => {
      const { orgId, token } = await invited();
      const rows = (await admin.query(`SELECT action, entity_id, target_org_id, actor_user_id, details FROM platform_audit WHERE action = 'company.created'`)).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entity_id: orgId, target_org_id: orgId, actor_user_id: IDS.root });
      expect(rows[0].details).toMatchObject({ name: 'Café Origen', country: 'EC', owner_email: 'dueno@cafe.test', delivery: 'sent' });
      const text = JSON.stringify(rows);
      expect(text).not.toContain(token.split('.')[1]);
      expect(text).not.toMatch(/invite_url|accept-invite/);
    });

    it('con plan: queda asignado y la empresa nace sin prueba; un plan inexistente da 404 y uno archivado 409, sin crear nada', async () => {
      const planId = uuidv7();
      await admin.query(`INSERT INTO plans(id, name) VALUES ($1, 'Pro')`, [planId]);
      const r = await create({ plan_id: planId });
      expect(r.status).toBe(201);
      const out = await json<CompanyOut>(r);
      expect(out.company.plan).toEqual({ id: planId, name: 'Pro' });
      expect((await admin.query(`SELECT plan_id FROM organizations WHERE id = $1`, [out.company.id])).rows[0].plan_id).toBe(planId);

      const n = (await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n;
      const missing = await create({ plan_id: uuidv7(), owner_email: 'otro@cafe.test' });
      expect(missing.status).toBe(404);
      expect(await codeOf(missing)).toBe('PLAN_NOT_FOUND');
      await admin.query(`UPDATE plans SET archived_at = now() WHERE id = $1`, [planId]);
      const archived = await create({ plan_id: planId, owner_email: 'otro@cafe.test' });
      expect(archived.status).toBe(409);
      expect(await codeOf(archived)).toBe('PLAN_ARCHIVED');
      expect((await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(n);
    });

    it.each([
      ['sin país', { country: undefined }],
      ['país inválido', { country: 'ZZ' }],
      ['país con 3 letras', { country: 'ECU' }],
      ['sin zona horaria', { timezone: undefined }],
      ['zona horaria inválida', { timezone: 'Mars/Olympus' }],
      ['correo inválido', { owner_email: 'no-es-correo' }],
      ['nombre vacío', { name: ' ' }],
      ['campo desconocido', { organization_id: ORG_A }],
    ])('400 %s', async (_n, over) => {
      const r = await create(over);
      expect(r.status).toBe(400);
      expect(await codeOf(r)).toBe('VALIDATION_ERROR');
      expect((await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(4);
    });

    it('el país se normaliza a mayúsculas y el correo a minúsculas', async () => {
      const r = await create({ country: 'ec', owner_email: '  Dueno@Cafe.TEST ' });
      expect(r.status).toBe(201);
      const out = await json<CompanyOut>(r);
      expect(out.company.country).toBe('EC');
      expect(out.invitation.email).toBe('dueno@cafe.test');
    });

    it('la lista de empresas la muestra «invited» con el correo invitado, el país y la caducidad; filtra por estado y busca por el correo', async () => {
      const { orgId } = await invited();
      const all = await companies();
      const row = all.items.find((c) => c.id === orgId)!;
      expect(row).toMatchObject({ state: 'invited', owner_email: 'dueno@cafe.test', country: 'EC', users: 0 });
      expect(row.invitation).toMatchObject({ email: 'dueno@cafe.test', expired: false });
      expect((await companies('?state=invited')).items.map((c) => c.id)).toEqual([orgId]);
      expect((await companies('?q=dueno%40cafe')).items.map((c) => c.id)).toEqual([orgId]);
      await admin.query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE organization_id = $1`, [orgId]);
      expect((await companies('?state=invited')).items[0]!.invitation!.expired).toBe(true);
    });
  });

  describe('correo que no sale (ADR-39 #5)', () => {
    it('si el proveedor falla: la empresa y la invitación existen, delivery=failed y el enlace va al Súper Admin; el enlace funciona', async () => {
      b.mail.failNext = true;
      const r = await create();
      expect(r.status).toBe(201);
      const out = await json<CompanyOut>(r);
      expect(out.invitation.delivery).toBe('failed');
      expect(out.invitation.invite_url).toMatch(/^https:\/\/app\.ejemplo\.test\/accept-invite#token=/);
      expect(b.mail.inviteOutbox).toHaveLength(0);
      expect((await accept(tokenOf(out.invitation.invite_url!))).status).toBe(200);
    });

    it('sin proveedor de correo (MAIL_PROVIDER=none): delivery=unavailable y el enlace funciona; sin FRONTEND_BASE_URL: 503 y no se crea nada', async () => {
      const none = await boot({ FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'none', CAPTCHA_PROVIDER: 'none', INVITATION_ATTEMPT_IP_MAX_PER_HOUR: '500' });
      try {
        const t = ((await (await fetch(`${none.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'root@plat.test', password: PW, token_transport: 'body' }) })).json()) as { access_token: string }).access_token;
        const r = await fetch(`${none.base}/platform/companies`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify(NEW_CO) });
        expect(r.status).toBe(201);
        const out = await json<CompanyOut>(r);
        expect(out.invitation.delivery).toBe('unavailable');
        const acc = await fetch(`${none.base}/auth/invitations/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tokenOf(out.invitation.invite_url!), password: NEW_PW, full_name: 'Dora Quinde', phone: '+593987654321' }) });
        expect(acc.status).toBe(200);
      } finally { await none.app.close(); }

      const n = (await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n;
      const nofront = await boot({ MAIL_PROVIDER: 'none', CAPTCHA_PROVIDER: 'none' });
      try {
        const t = ((await (await fetch(`${nofront.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'root@plat.test', password: PW, token_transport: 'body' }) })).json()) as { access_token: string }).access_token;
        const r = await fetch(`${nofront.base}/platform/companies`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ ...NEW_CO, owner_email: 'otro@cafe.test' }) });
        expect(r.status).toBe(503);
        expect((await r.json() as { error: { code: string } }).error.code).toBe('INVITATIONS_UNAVAILABLE');
        expect((await admin.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(n);
      } finally { await nofront.app.close(); }
    });
  });

  describe('vista previa y aceptación', () => {
    it('vista previa: empresa, correo, rol, caducidad y si el correo ya tiene cuenta', async () => {
      const { token } = await invited();
      const r = await preview(token);
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(await json(r)).toMatchObject({ organization_name: 'Café Origen', email: 'dueno@cafe.test', role: 'client_admin', account_exists: false });
      const existing = await invited({ owner_email: 'alice@a.test', name: 'Otra Empresa' });
      expect(await json(await preview(existing.token))).toMatchObject({ email: 'alice@a.test', account_exists: true });
    });

    it('cuenta nueva SIN plan: crea el usuario activo y verificado, la membresía client_admin y la prueba de 7 días; el enlace queda consumido', async () => {
      const { orgId, token } = await invited();
      const r = await accept(token);
      expect(r.status).toBe(200);
      expect(await json(r)).toEqual({ status: 'accepted', email: 'dueno@cafe.test', account_created: true });
      const u = (await admin.query(`SELECT id, status, email_verified_at, full_name, phone FROM users WHERE email = 'dueno@cafe.test'`)).rows[0];
      expect(u).toMatchObject({ status: 'active', full_name: 'Dora Quinde', phone: '+593987654321' });
      expect(u.email_verified_at).not.toBeNull();
      const m = (await admin.query(`SELECT role, granted_by, revoked_at FROM organization_members WHERE user_id = $1 AND organization_id = $2`, [u.id, orgId])).rows;
      expect(m).toEqual([{ role: 'client_admin', granted_by: IDS.root, revoked_at: null }]);
      const t = (await admin.query(`SELECT owner_user_id, started_at, ends_at, status FROM trials WHERE organization_id = $1`, [orgId])).rows[0];
      expect(t.owner_user_id).toBe(u.id);
      expect(Math.round((t.ends_at.getTime() - t.started_at.getTime()) / DAY)).toBe(7);
      const inv = (await admin.query(`SELECT consumed_at, accepted_user_id FROM invitations WHERE organization_id = $1`, [orgId])).rows[0];
      expect(inv.consumed_at).not.toBeNull();
      expect(inv.accepted_user_id).toBe(u.id);
      // el dueño ya puede entrar con la contraseña elegida y la empresa pasa de «invited» a «trial»
      expect((await call('POST', '/auth/login', undefined, { email: 'dueno@cafe.test', password: NEW_PW, token_transport: 'body' })).status).toBe(200);
      expect((await companies()).items.find((c) => c.id === orgId)).toMatchObject({ state: 'trial', users: 1, invitation: null });
    });

    it('cuenta nueva CON plan: sin prueba (ADR-38); la empresa queda «active»', async () => {
      const planId = uuidv7();
      await admin.query(`INSERT INTO plans(id, name) VALUES ($1, 'Pro')`, [planId]);
      const { orgId, token } = await invited({ plan_id: planId });
      expect((await accept(token)).status).toBe(200);
      expect((await admin.query(`SELECT count(*)::int AS n FROM trials WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(0);
      expect((await companies()).items.find((c) => c.id === orgId)!.state).toBe('active');
    });

    it('cuenta nueva: faltan nombre/WhatsApp o la contraseña es corta → 400 con el detalle; el enlace NO se consume', async () => {
      const { orgId, token } = await invited();
      const r = await accept(token, { full_name: undefined, phone: undefined, password: 'corta' });
      expect(r.status).toBe(400);
      const e = await json<{ error: { code: string; details: Array<{ path: string }> } }>(r);
      expect(e.error.code).toBe('VALIDATION_ERROR');
      expect(e.error.details.map((d) => d.path).sort()).toEqual(['full_name', 'password', 'phone']);
      expect((await accept(token, { phone: '098 421 7730' })).status).toBe(400); // no es E.164
      expect((await admin.query(`SELECT consumed_at FROM invitations WHERE organization_id = $1`, [orgId])).rows[0].consumed_at).toBeNull();
      expect((await accept(token)).status).toBe(200);
    });

    it('cuenta EXISTENTE: no se duplica el usuario ni cambia su contraseña; confirma con la actual y se AÑADE la membresía', async () => {
      const { orgId, token } = await invited({ owner_email: 'alice@a.test', name: 'Segunda Empresa' });
      const usersBefore = (await admin.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n;
      const wrong = await accept(token, { password: 'No-Es-La-Clave-1' });
      expect(wrong.status).toBe(400);
      expect(await codeOf(wrong)).toBe('INVALID_PASSWORD');
      expect((await admin.query(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(0);
      const ok = await accept(token, { password: PW, full_name: undefined, phone: undefined });
      expect(ok.status).toBe(200);
      expect(await json(ok)).toEqual({ status: 'accepted', email: 'alice@a.test', account_created: false });
      expect((await admin.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(usersBefore);
      expect((await admin.query(`SELECT user_id FROM organization_members WHERE organization_id = $1 AND revoked_at IS NULL`, [orgId])).rows).toEqual([{ user_id: IDS.alice }]);
      expect((await admin.query(`SELECT count(*)::int AS n FROM organization_members WHERE user_id = $1 AND revoked_at IS NULL`, [IDS.alice])).rows[0].n).toBe(2);
      await login('alice@a.test'); // su contraseña sigue siendo la de antes
      expect((await admin.query(`SELECT count(*)::int AS n FROM trials WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(1); // sin plan: la prueba empieza al aceptar
    });

    it('cuenta existente: la contraseña equivocada cuenta para el bloqueo por intentos de esa cuenta (429 al 5.º fallo, también con la contraseña correcta)', async () => {
      const { token } = await invited({ owner_email: 'alice@a.test', name: 'Segunda Empresa' });
      for (let i = 0; i < 5; i++) expect((await accept(token, { password: 'No-Es-La-Clave-1' })).status).toBe(400);
      const locked = await accept(token, { password: PW });
      expect(locked.status).toBe(429);
      expect(locked.headers.get('retry-after')).toMatch(/^\d+$/);
    });

    it('un solo uso: la segunda aceptación y la vista previa del mismo enlace dan el mismo error genérico', async () => {
      const { token } = await invited();
      expect((await accept(token)).status).toBe(200);
      const again = await accept(token);
      const prev = await preview(token);
      expect(again.status).toBe(400);
      expect(await codeOf(again.clone())).toBe('INVALID_INVITATION');
      expect(scrub(await json(again))).toBe(scrub(await json(prev)));
    });

    it('enlaces inválidos (basura, secreto alterado, id inexistente, falta el punto) responden IDÉNTICO y no revelan nada', async () => {
      const { token } = await invited();
      const [id, secret] = token.split('.') as [string, string];
      const flipped = secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A');
      const bad = ['basura', `${id}.${flipped}`, `${uuidv7()}.${secret}`, id, `${id}.`, '.', `${id}.${secret}x`];
      const seen = new Set<string>();
      for (const t of bad) {
        for (const r of [await preview(t), await accept(t)]) {
          expect(r.status, t).toBe(400);
          seen.add(scrub(await json(r)));
        }
      }
      expect(seen.size).toBe(1);
      expect([...seen][0]).toContain('INVALID_INVITATION');
      expect((await accept(token)).status).toBe(200); // el enlace bueno sigue intacto tras los intentos
    });

    it('caducada: INVITATION_EXPIRED (solo con el token auténtico); el reenvío la revive y el enlace viejo deja de valer', async () => {
      const { orgId, token } = await invited();
      await admin.query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE organization_id = $1`, [orgId]);
      for (const r of [await preview(token), await accept(token)]) {
        expect(r.status).toBe(400);
        expect(await codeOf(r)).toBe('INVITATION_EXPIRED');
      }
      await admin.query(`UPDATE invitations SET last_sent_at = now() - interval '1 hour' WHERE organization_id = $1`, [orgId]);
      const rs = await call('POST', `/platform/companies/${orgId}/invitation/resend`, rootToken);
      expect(rs.status).toBe(200);
      const fresh = tokenOf(b.mail.lastInvitation('dueno@cafe.test')!.inviteUrl);
      expect(fresh).not.toBe(token);
      expect(await codeOf(await accept(token))).toBe('INVALID_INVITATION'); // el reemplazo anuló el enlace viejo (id distinto)
      expect((await accept(fresh)).status).toBe(200);
    });

    it('aislamiento A↔B: aceptar la invitación de una empresa añade la membresía SOLO a esa empresa; no toca otras ni a otros usuarios', async () => {
      const x = await invited({ owner_email: 'x@x.test', name: 'Empresa X' });
      const y = await invited({ owner_email: 'y@y.test', name: 'Empresa Y' });
      const before = (await admin.query(`SELECT user_id, organization_id FROM organization_members ORDER BY 1, 2`)).rows;
      expect((await accept(x.token)).status).toBe(200);
      const after = (await admin.query(`SELECT user_id, organization_id FROM organization_members ORDER BY 1, 2`)).rows;
      expect(after).toHaveLength(before.length + 1);
      expect((await admin.query(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [y.orgId])).rows[0].n).toBe(0);
      expect((await admin.query(`SELECT consumed_at FROM invitations WHERE organization_id = $1`, [y.orgId])).rows[0].consumed_at).toBeNull();
      // el token de X no sirve para Y ni al revés (los ids son distintos)
      expect((await accept(y.token, { password: NEW_PW })).status).toBe(200);
      expect((await admin.query(`SELECT organization_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'x@x.test'`)).rows).toEqual([{ organization_id: x.orgId }]);
    });

    it('empresa suspendida o borrada: la invitación deja de valer (mismo error genérico)', async () => {
      const a = await invited({ owner_email: 'a1@x.test', name: 'Susp' });
      const d = await invited({ owner_email: 'd1@x.test', name: 'Borrada' });
      await admin.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [a.orgId]);
      await admin.query(`UPDATE organizations SET deleted_at = now() WHERE id = $1`, [d.orgId]);
      for (const t of [a.token, d.token]) expect(await codeOf(await accept(t))).toBe('INVALID_INVITATION');
    });

    it('concurrencia: dos aceptaciones simultáneas del mismo enlace → una gana (200) y la otra recibe 400; un solo usuario y una sola membresía', async () => {
      const { orgId, token } = await invited();
      const rs = await Promise.all([accept(token), accept(token)]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
      expect((await admin.query(`SELECT count(*)::int AS n FROM users WHERE email = 'dueno@cafe.test'`)).rows[0].n).toBe(1);
      expect((await admin.query(`SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(1);
      expect((await admin.query(`SELECT count(*)::int AS n FROM trials WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(1);
    });

    it('un correo pendiente o desactivado no se «adopta»: la invitación a una cuenta no activa falla con el error genérico', async () => {
      await admin.query(`INSERT INTO users(id,email,password_hash,status) VALUES ($1,'pend@x.test',$2,'pending')`, [uuidv7(), hash]);
      const { token } = await invited({ owner_email: 'pend@x.test', name: 'Pendiente' });
      expect(await codeOf(await accept(token, { password: PW }))).toBe('INVALID_INVITATION');
    });
  });

  describe('reenviar', () => {
    it('reemplaza el token, suma sent_count, respeta el enfriamiento (429 + Retry-After) y registra la auditoría', async () => {
      const { orgId, token } = await invited();
      const early = await call('POST', `/platform/companies/${orgId}/invitation/resend`, rootToken);
      expect(early.status).toBe(429);
      expect(early.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(b.mail.inviteOutbox).toHaveLength(1);
      await admin.query(`UPDATE invitations SET last_sent_at = now() - interval '2 minutes' WHERE organization_id = $1`, [orgId]);
      const r = await call('POST', `/platform/companies/${orgId}/invitation/resend`, rootToken);
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(await json(r)).toMatchObject({ email: 'dueno@cafe.test', delivery: 'sent' });
      expect(b.mail.inviteOutbox).toHaveLength(2);
      expect((await admin.query(`SELECT sent_count FROM invitations WHERE organization_id = $1`, [orgId])).rows[0].sent_count).toBe(2);
      expect((await admin.query(`SELECT count(*)::int AS n FROM invitations WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(1); // sigue habiendo UNA fila
      expect(await codeOf(await preview(token))).toBe('INVALID_INVITATION');
      const audit = (await admin.query(`SELECT details FROM platform_audit WHERE action = 'company.invitation_resent'`)).rows;
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toMatch(/token|accept-invite/);
    });

    it('409 si ya fue aceptada; 404 si la empresa no existe o no tiene invitación; 400 si el id no es un UUID', async () => {
      const { orgId, token } = await invited();
      await accept(token);
      await admin.query(`UPDATE invitations SET last_sent_at = now() - interval '1 hour'`);
      const done = await call('POST', `/platform/companies/${orgId}/invitation/resend`, rootToken);
      expect(done.status).toBe(409);
      expect(await codeOf(done)).toBe('INVITATION_ALREADY_ACCEPTED');
      expect((await call('POST', `/platform/companies/${uuidv7()}/invitation/resend`, rootToken)).status).toBe(404);
      expect((await call('POST', `/platform/companies/${ORG_B}/invitation/resend`, rootToken)).status).toBe(404); // empresa sin invitación
      expect((await call('POST', `/platform/companies/no-es-uuid/invitation/resend`, rootToken)).status).toBe(400);
    });

    it('si el correo falla al reenviar: delivery=failed y el enlace nuevo va al Súper Admin', async () => {
      const { orgId } = await invited();
      await admin.query(`UPDATE invitations SET last_sent_at = now() - interval '1 hour' WHERE organization_id = $1`, [orgId]);
      b.mail.failNext = true;
      const out = await json<{ delivery: string; invite_url?: string }>(await call('POST', `/platform/companies/${orgId}/invitation/resend`, rootToken));
      expect(out.delivery).toBe('failed');
      expect(out.invite_url).toMatch(/#token=/);
    });
  });

  describe('límites', () => {
    it('vista previa y aceptación comparten el límite por IP (429 al superarlo)', async () => {
      const lim = await boot({ ...GENEROUS, INVITATION_ATTEMPT_IP_MAX_PER_HOUR: '5' });
      try {
        const codes: number[] = [];
        for (let i = 0; i < 7; i++) codes.push((await fetch(`${lim.base}/auth/invitations/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'basura' }) })).status);
        expect(codes).toEqual([400, 400, 400, 400, 400, 429, 429]);
      } finally { await lim.app.close(); }
    });
  });

  describe('base de datos', () => {
    it('invitations: un correo por empresa; correo normalizado; hash hexadecimal; consumo coherente (CHECK/único)', async () => {
      const { orgId } = await invited();
      const dup = admin.query(`INSERT INTO invitations(id, organization_id, email, role, token_hash, expires_at, invited_by) VALUES ($1,$2,'dueno@cafe.test','client_admin',repeat('a',64), now(), $3)`, [uuidv7(), orgId, IDS.root]);
      await expect(dup).rejects.toThrow(/invitations_org_email_uq/);
      await expect(admin.query(`INSERT INTO invitations(id, organization_id, email, role, token_hash, expires_at, invited_by) VALUES ($1,$2,'MAYUS@x.test','client_admin',repeat('a',64), now(), $3)`, [uuidv7(), orgId, IDS.root])).rejects.toThrow(/invitations_email_normalized/);
      await expect(admin.query(`INSERT INTO invitations(id, organization_id, email, role, token_hash, expires_at, invited_by) VALUES ($1,$2,'a@x.test','client_admin','no-hex', now(), $3)`, [uuidv7(), orgId, IDS.root])).rejects.toThrow(/invitations_token_hash_hex/);
      await expect(admin.query(`UPDATE invitations SET consumed_at = now() WHERE organization_id = $1`, [orgId])).rejects.toThrow(/invitations_consumed_consistent/);
      await expect(admin.query(`UPDATE organizations SET country = 'ecuador' WHERE id = $1`, [orgId])).rejects.toThrow(/organizations_country_iso2/);
    });
  });
});
