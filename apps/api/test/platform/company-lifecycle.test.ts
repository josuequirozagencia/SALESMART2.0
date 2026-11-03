// F3a (ADR-59) — Eliminar y recuperar una empresa (consola del Súper Admin). Rutas cubiertas (el registro de endpoints exige que este archivo las mencione):
//   GET /v1/platform/companies/:id/deletion-preview
//   POST /v1/platform/companies/:id/delete
//   POST /v1/platform/companies/:id/recover
import 'reflect-metadata';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uuidv7 } from '@sales-smart/shared';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { MAIL_PROVIDER, MemoryMailProvider } from '../../src/modules/auth/signup';
import { AttributionEndpointsService, FormRoutesService, GhlRoutesService, OrgDirectoryService, OrganizationsModule } from '../../src/modules/organizations';
import { ChannelRoutesService, QrRoutesService } from '../../src/modules/organizations';
import { RequirePermission } from '../../src/rbac';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, ORG_C, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Controller('probe')
class ProbeController {
  @RequirePermission('contacts.read')
  @Get('business')
  business() { return { ok: true }; }
}
@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [ProbeController] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const DAY = 86_400_000;
const IDS = {
  platformOrg: '00000000-0000-4000-8000-0000000000f0',
  agencyOrg: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  alice: 'a0000000-0000-4000-8000-00000000000a', // client_admin de A (el dueño)
  bob: 'b0000000-0000-4000-8000-00000000000b', // client_admin de B
  carol: 'c0000000-0000-4000-8000-0000000000c3', // advisor de A
  dave: 'd0000000-0000-4000-8000-0000000000d4', // agency (personal de la agencia)
  root: 'f0000000-0000-4000-8000-0000000000f1',
};
let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
let mail: MemoryMailProvider;
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE organization_deletions, meta_events, automation_runs, automations, contacts, ghl_routes, qr_routes, channel_routes, form_routes, attribution_endpoints, sessions, auth_throttle, trials, invitations, organization_members, organizations, users, plans, platform_audit CASCADE');
  const orgs: Array<[string, string, string]> = [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Barbería Norte'], [ORG_B, 'client', 'Estudio Luna'], [ORG_C, 'client', 'Café Origen'], [IDS.agencyOrg, 'agency', 'Agencia Demo']];
  for (const [id, kind, name] of orgs) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'America/Guayaquil')`, [id, kind, name]);
  const users: Array<[string, string, string | null]> = [[IDS.alice, 'alice@a.test', 'Alicia Torres'], [IDS.bob, 'bob@b.test', 'Beto Ruiz'], [IDS.carol, 'carol@a.test', null], [IDS.dave, 'dave@agencia.test', 'Dana Vega'], [IDS.root, 'root@plat.test', null]];
  for (const [id, email, name] of users) await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at,full_name) VALUES ($1,$2,$3,'active',now(),$4)`, [id, email, hash, name]);
  const members: Array<[string, string, string]> = [[IDS.alice, ORG_A, 'client_admin'], [IDS.carol, ORG_A, 'advisor'], [IDS.bob, ORG_B, 'client_admin'], [IDS.dave, IDS.agencyOrg, 'agency'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  await admin.query(`UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [IDS.alice, ORG_A]);
  await admin.query(`UPDATE organizations SET owner_user_id = $1 WHERE id = $2`, [IDS.bob, ORG_B]);
  mail.companyDeletedOutbox.length = 0;
  mail.companyRecoveredOutbox.length = 0;
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY, FRONTEND_BASE_URL: 'https://app.ejemplo.test', MAIL_PROVIDER: 'memory', CAPTCHA_PROVIDER: 'fake' });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
  mail = app.get(MAIL_PROVIDER, { strict: false }) as MemoryMailProvider;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(seed);

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function login(email: string, password = PW): Promise<string> {
  const r = await call('POST', '/auth/login', undefined, { email, password, token_transport: 'body' });
  expect(r.status).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const json = async <T,>(r: Response): Promise<T> => (await r.json()) as T;
const codeOf = async (r: Response): Promise<string> => (await json<{ error: { code: string } }>(r)).error.code;
interface Company { id: string; name: string; state: string; deletion: { requested_at: string; purge_after: string; reason: string | null } | null }
interface Preview { id: string; name: string; kind: string; state: string; plan: string | null; footprint: { users: number; contacts: number; sales: number; ai_credits: number; clients: number }; blockers: Array<{ code: string; clients: Array<{ id: string; name: string }> }>; deletion: { purge_after: string; reason: string } | null; window_days: number }

let rootToken = '';
const del = (orgId: string, over: Record<string, unknown> = {}, token = rootToken) => call('POST', `/platform/companies/${orgId}/delete`, token, { password: PW, confirm_name: nameOf[orgId], reason: 'La empresa pidió cerrar su cuenta', ...over });
const recover = (orgId: string, over: Record<string, unknown> = {}, token = rootToken) => call('POST', `/platform/companies/${orgId}/recover`, token, { password: PW, ...over });
const nameOf: Record<string, string> = { [ORG_A]: 'Barbería Norte', [ORG_B]: 'Estudio Luna', [ORG_C]: 'Café Origen', [IDS.agencyOrg]: 'Agencia Demo' };
const status = async (orgId: string) => (await admin.query(`SELECT status, deleted_at FROM organizations WHERE id = $1`, [orgId])).rows[0] as { status: string; deleted_at: Date | null };
const companies = async (qs = ''): Promise<Company[]> => (await json<{ items: Company[] }>(await call('GET', `/platform/companies${qs}`, rootToken))).items;
beforeEach(async () => { rootToken = await login('root@plat.test'); });

describe('acceso: solo el Súper Admin', () => {
  it('sin sesión 401 y con una sesión de cliente, asesor o agencia 403 en las tres rutas; no cambia nada', async () => {
    const tokens = [await login('alice@a.test'), await login('carol@a.test'), await login('dave@agencia.test')];
    const routes: Array<[string, string, unknown?]> = [
      ['GET', `/platform/companies/${ORG_A}/deletion-preview`],
      ['POST', `/platform/companies/${ORG_A}/delete`, { password: PW, confirm_name: nameOf[ORG_A], reason: 'Intento de un administrador' }],
      ['POST', `/platform/companies/${ORG_A}/recover`, { password: PW }],
    ];
    for (const [m, p, b] of routes) {
      expect((await call(m, p, undefined, b)).status, `${m} ${p} sin sesión`).toBe(401);
      for (const t of tokens) expect((await call(m, p, t, b)).status, `${m} ${p} no es Súper Admin`).toBe(403);
    }
    expect(await status(ORG_A)).toMatchObject({ status: 'active', deleted_at: null });
    expect((await admin.query(`SELECT count(*)::int AS n FROM organization_deletions`)).rows[0].n).toBe(0);
  });
});

describe('vista previa', () => {
  it('muestra el nombre, las personas con acceso y lo que se perdería; no cambia nada', async () => {
    await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES ($1,$2,'Cliente Uno'), ($3,$2,'Cliente Dos')`, [uuidv7(), ORG_A, uuidv7()]);
    const r = await call('GET', `/platform/companies/${ORG_A}/deletion-preview`, rootToken);
    expect(r.status).toBe(200);
    const p = await json<Preview>(r);
    expect(p).toMatchObject({ id: ORG_A, name: 'Barbería Norte', kind: 'client', state: 'active', blockers: [], deletion: null, window_days: 7 });
    expect(p.footprint).toMatchObject({ users: 2, contacts: 2, sales: 0, ai_credits: 0, clients: 0 });
    expect(await status(ORG_A)).toMatchObject({ status: 'active' });
  });

  it('una agencia con clientes lo dice, con la lista; la plataforma y lo inexistente son 404', async () => {
    await admin.query(`UPDATE organizations SET parent_agency_id = $1 WHERE id IN ($2, $3)`, [IDS.agencyOrg, ORG_A, ORG_B]);
    const p = await json<Preview>(await call('GET', `/platform/companies/${IDS.agencyOrg}/deletion-preview`, rootToken));
    expect(p.kind).toBe('agency');
    expect(p.footprint.clients).toBe(2);
    expect(p.blockers).toEqual([{ code: 'AGENCY_HAS_CLIENTS', clients: [{ id: ORG_B, name: 'Estudio Luna' }, { id: ORG_A, name: 'Barbería Norte' }].sort((x, y) => x.name.localeCompare(y.name)) }]);
    expect((await call('GET', `/platform/companies/${IDS.platformOrg}/deletion-preview`, rootToken)).status).toBe(404);
    expect((await call('GET', `/platform/companies/${uuidv7()}/deletion-preview`, rootToken)).status).toBe(404);
    expect((await call('GET', `/platform/companies/no-es-un-uuid/deletion-preview`, rootToken)).status).toBe(400);
  });
});

describe('eliminar', () => {
  it('contraseña incorrecta: 403 PASSWORD_INVALID, no elimina nada, no cierra la sesión y el intento cuenta; a los 5 intentos, 429', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await del(ORG_A, { password: 'No-Es-La-Clave-1' });
      expect(r.status).toBe(403);
      expect(await codeOf(r)).toBe('PASSWORD_INVALID');
    }
    expect(await status(ORG_A)).toMatchObject({ status: 'active', deleted_at: null });
    expect((await call('GET', `/platform/companies/${ORG_A}/deletion-preview`, rootToken)).status).toBe(200); // la sesión sigue viva
    expect((await del(ORG_A, { password: 'No-Es-La-Clave-1' })).status).toBe(403); // el quinto fallo
    const locked = await del(ORG_A); // ni siquiera la contraseña buena pasa mientras dure el bloqueo
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBeTruthy();
    expect(await status(ORG_A)).toMatchObject({ status: 'active' });
    expect((await admin.query(`SELECT count(*)::int AS n FROM organization_deletions`)).rows[0].n).toBe(0);
  });

  it('el nombre debe coincidir exacto, el motivo tener 10 a 300 caracteres y el cuerpo no admite campos de más', async () => {
    const wrongName = await del(ORG_A, { confirm_name: 'barbería norte' });
    expect(wrongName.status).toBe(400);
    expect((await json<{ error: { details: Array<{ path: string }> } }>(wrongName)).error.details[0]?.path).toBe('confirm_name');
    expect((await del(ORG_A, { reason: 'corto' })).status).toBe(400);
    expect((await del(ORG_A, { reason: 'x'.repeat(301) })).status).toBe(400);
    expect((await del(ORG_A, { force: true })).status).toBe(400);
    expect((await call('POST', `/platform/companies/${ORG_A}/delete`, rootToken, { password: PW })).status).toBe(400);
    expect(await status(ORG_A)).toMatchObject({ status: 'active', deleted_at: null });
  });

  it('elimina: estado «deleted» con fecha, ventana de 7 días, sesiones y acceso cortados al instante, auditoría y correos', async () => {
    const aliceToken = await login('alice@a.test');
    const carolToken = await login('carol@a.test');
    const bobToken = await login('bob@b.test');
    expect((await call('GET', '/probe/business', aliceToken)).status).toBe(200);
    const before = Date.now();
    const r = await del(ORG_A);
    expect(r.status).toBe(200);
    const out = await json<{ id: string; deletion_id: string; state: string; purge_after: string; notified: number }>(r);
    expect(out).toMatchObject({ id: ORG_A, state: 'deleted', notified: 1 });
    expect(new Date(out.purge_after).getTime() - before).toBeGreaterThan(7 * DAY - 60_000);
    expect(new Date(out.purge_after).getTime() - before).toBeLessThan(7 * DAY + 60_000);
    expect(await status(ORG_A)).toMatchObject({ status: 'deleted' });
    expect((await status(ORG_A)).deleted_at).not.toBeNull();
    const d = (await admin.query(`SELECT * FROM organization_deletions WHERE organization_id = $1`, [ORG_A])).rows[0];
    expect(d).toMatchObject({ id: out.deletion_id, requested_by: IDS.root, organization_name: 'Barbería Norte', previous_status: 'active', state: 'scheduled', reason: 'La empresa pidió cerrar su cuenta' });
    expect(d.summary).toMatchObject({ users: 2, contacts: 0 });
    // El acceso se corta YA: las sesiones de la empresa quedan revocadas y no se puede volver a entrar
    expect((await call('GET', '/probe/business', aliceToken)).status).toBe(401);
    expect((await call('GET', '/probe/business', carolToken)).status).toBe(401);
    expect((await call('POST', '/auth/login', undefined, { email: 'alice@a.test', password: PW, token_transport: 'body' })).status).toBe(401);
    expect((await admin.query(`SELECT count(*)::int AS n FROM sessions WHERE active_org_id = $1 AND revoked_at IS NULL`, [ORG_A])).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT DISTINCT revoke_reason FROM sessions WHERE active_org_id = $1`, [ORG_A])).rows.map((x) => x.revoke_reason)).toEqual(['company_deleted']);
    // A↔B: la otra empresa no se entera de nada
    expect((await call('GET', '/probe/business', bobToken)).status).toBe(200);
    expect(await status(ORG_B)).toMatchObject({ status: 'active', deleted_at: null });
    // Auditoría de plataforma (sin la contraseña) y aviso al dueño
    const a = (await admin.query(`SELECT action, actor_user_id, target_org_id, details FROM platform_audit WHERE action = 'company.deleted'`)).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_user_id: IDS.root, target_org_id: ORG_A });
    expect(a[0].details).toMatchObject({ name: 'Barbería Norte', reason: 'La empresa pidió cerrar su cuenta', previous_status: 'active', users: 2 });
    expect(JSON.stringify(a[0].details)).not.toContain(PW);
    expect(mail.companyDeletedOutbox).toHaveLength(1);
    expect(mail.companyDeletedOutbox[0]).toMatchObject({ to: 'alice@a.test', organizationName: 'Barbería Norte', audience: 'owner', timeZone: 'America/Guayaquil' });
  });

  it('la lista de la plataforma oculta las eliminadas salvo con el filtro «deleted», que trae la fecha de borrado y el motivo; no se le puede cambiar el plan', async () => {
    await del(ORG_A);
    expect((await companies()).map((c) => c.id)).not.toContain(ORG_A);
    const only = await companies('?state=deleted');
    expect(only.map((c) => c.id)).toEqual([ORG_A]);
    expect(only[0]).toMatchObject({ state: 'deleted' });
    expect(only[0]!.deletion).toMatchObject({ reason: 'La empresa pidió cerrar su cuenta' });
    expect(new Date(only[0]!.deletion!.purge_after).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    const plan = await admin.query(`INSERT INTO plans(id, name) VALUES ($1, 'Pro') RETURNING id`, [uuidv7()]);
    const r = await call('PUT', `/platform/companies/${ORG_A}/plan`, rootToken, { plan_id: plan.rows[0].id });
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe('COMPANY_DELETED');
  });

  it('eliminar dos veces: 409 ALREADY_DELETED y una sola fila; la plataforma y lo inexistente son 404', async () => {
    expect((await del(ORG_A)).status).toBe(200);
    const again = await del(ORG_A);
    expect(again.status).toBe(409);
    expect(await codeOf(again)).toBe('ALREADY_DELETED');
    expect((await admin.query(`SELECT count(*)::int AS n FROM organization_deletions WHERE organization_id = $1`, [ORG_A])).rows[0].n).toBe(1);
    nameOf[IDS.platformOrg] = 'Plataforma';
    expect((await del(IDS.platformOrg)).status).toBe(404);
    expect(await status(IDS.platformOrg)).toMatchObject({ status: 'active', deleted_at: null });
    expect((await del(uuidv7(), { confirm_name: 'Fantasma' })).status).toBe(404);
  });

  it('una agencia con clientes no se elimina (409 con la lista); sin clientes sí', async () => {
    await admin.query(`UPDATE organizations SET parent_agency_id = $1 WHERE id = $2`, [IDS.agencyOrg, ORG_A]);
    const blocked = await del(IDS.agencyOrg);
    expect(blocked.status).toBe(409);
    const body = await json<{ error: { code: string; details: Array<{ path: string; message: string }> } }>(blocked);
    expect(body.error.code).toBe('AGENCY_HAS_CLIENTS');
    expect(body.error.details).toEqual([{ path: ORG_A, code: 'client', message: 'Barbería Norte' }]);
    expect(await status(IDS.agencyOrg)).toMatchObject({ status: 'active', deleted_at: null });
    // Con el cliente eliminado ya no cuenta: la agencia queda libre y su personal recibe el aviso del cliente eliminado
    expect((await del(ORG_A)).status).toBe(200);
    expect(mail.companyDeletedOutbox.map((m) => [m.to, m.audience]).sort()).toEqual([['alice@a.test', 'owner'], ['dave@agencia.test', 'agency']]);
    expect((await del(IDS.agencyOrg)).status).toBe(200);
    expect(await status(IDS.agencyOrg)).toMatchObject({ status: 'deleted' });
    expect((await admin.query(`SELECT count(*)::int AS n FROM sessions WHERE home_org_id = $1 AND revoked_at IS NULL`, [IDS.agencyOrg])).rows[0].n).toBe(0);
  });

  it('un fallo de correo no deshace la eliminación (queda confirmada y sin aviso)', async () => {
    mail.failNext = true;
    const r = await del(ORG_A);
    expect(r.status).toBe(200);
    expect((await json<{ notified: number }>(r)).notified).toBe(0);
    expect(await status(ORG_A)).toMatchObject({ status: 'deleted' });
  });

  it('el dueño sin registrar: se avisa al primer administrador vigente', async () => {
    await admin.query(`UPDATE organizations SET owner_user_id = NULL WHERE id = $1`, [ORG_A]);
    expect((await del(ORG_A)).status).toBe(200);
    expect(mail.companyDeletedOutbox.map((m) => m.to)).toEqual(['alice@a.test']);
  });
});

describe('qué se detiene al eliminar (ADR-59 #4 y #5)', () => {
  const dir = () => app.get(OrgDirectoryService, { strict: false });

  async function seedRoutes() {
    for (const org of [ORG_A, ORG_B]) {
      await admin.query(`INSERT INTO ghl_routes(id, organization_id, secret_hash) VALUES ($1,$2,$3)`, [uuidv7(), org, 'a'.repeat(64)]);
      await admin.query(`INSERT INTO qr_routes(id, organization_id, channel_account_id, token_hash) VALUES ($1,$2,$3,$4)`, [uuidv7(), org, uuidv7(), 'b'.repeat(64)]);
    }
    await admin.query(`INSERT INTO channel_routes(phone_number_id, organization_id, channel_account_id) VALUES ('1000000000001', $1, $2), ('1000000000002', $3, $4)`, [ORG_A, uuidv7(), ORG_B, uuidv7()]);
  }

  it('las cuatro enumeraciones de empresas (clientes, activas, canales y QR, GoHighLevel) dejan de devolverla; al recuperar vuelve', async () => {
    await seedRoutes();
    const all = async () => ({
      clients: (await dir().clientOrganizationIds()).sort(),
      active: (await app.get(AttributionEndpointsService, { strict: false }).activeClientOrgIds()).sort(),
      channels: (await app.get(ChannelRoutesService, { strict: false }).organizationIds()).sort(),
      qr: (await app.get(QrRoutesService, { strict: false }).organizationIds()).sort(),
      ghl: (await app.get(GhlRoutesService, { strict: false }).organizationIds()).sort(),
    });
    const before = await all();
    for (const k of ['channels', 'qr', 'ghl'] as const) expect(before[k], k).toEqual([ORG_A, ORG_B].sort());
    for (const k of ['clients', 'active'] as const) expect(before[k], k).toContain(ORG_A);

    expect((await del(ORG_A)).status).toBe(200);
    const during = await all();
    for (const k of ['clients', 'active'] as const) {
      expect(during[k], k).not.toContain(ORG_A);
      expect(during[k], k).toContain(ORG_B);
    }
    for (const k of ['channels', 'qr', 'ghl'] as const) expect(during[k], k).toEqual([ORG_B]);

    expect((await recover(ORG_A)).status).toBe(200);
    expect(await all()).toEqual(before);
  });

  it('una empresa suspendida tampoco se recorre (la misma regla central), y sigue sin recorrerse al recuperarla si ya estaba suspendida', async () => {
    await seedRoutes();
    await admin.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ORG_B]);
    expect(await dir().clientOrganizationIds()).not.toContain(ORG_B);
    expect(await app.get(GhlRoutesService, { strict: false }).organizationIds()).toEqual([ORG_A]);
  });

  it('los formularios públicos de una empresa eliminada no se resuelven (404 uniforme); el de otra empresa sí; al recuperar vuelve', async () => {
    const tokenA = uuidv7();
    const tokenB = uuidv7();
    const formA = uuidv7();
    const formB = uuidv7();
    await admin.query(`INSERT INTO form_routes(id, organization_id, form_id) VALUES ($1,$2,$3), ($4,$5,$6)`, [tokenA, ORG_A, formA, tokenB, ORG_B, formB]);
    const routes = app.get(FormRoutesService, { strict: false });
    expect(await routes.resolve(tokenA)).toEqual({ organizationId: ORG_A, formId: formA });
    await del(ORG_A);
    expect(await routes.resolve(tokenA)).toBeNull();
    expect(await routes.resolve(tokenB)).toEqual({ organizationId: ORG_B, formId: formB });
    await recover(ORG_A);
    expect(await routes.resolve(tokenA)).toEqual({ organizationId: ORG_A, formId: formA });
  });

  it('`isOperating` (la regla de las puertas públicas): activa sí; eliminada, suspendida o inexistente no', async () => {
    expect(await dir().isOperating(ORG_A)).toBe(true);
    await del(ORG_A);
    expect(await dir().isOperating(ORG_A)).toBe(false);
    await admin.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ORG_B]);
    expect(await dir().isOperating(ORG_B)).toBe(false);
    expect(await dir().isOperating(uuidv7())).toBe(false);
  });

  it('una invitación pendiente a la empresa eliminada deja de servir (vista previa y aceptación dan el mismo error uniforme); al recuperar vuelve', async () => {
    const created = await call('POST', '/platform/companies', rootToken, { name: 'Taller Nuevo', owner_email: 'dueno@taller.test', timezone: 'America/Guayaquil', country: 'EC' });
    expect(created.status).toBe(201);
    const company = (await json<{ company: { id: string } }>(created)).company;
    const token = mail.lastInvitationToken('dueno@taller.test');
    expect(token).toBeTruthy();
    expect((await call('POST', '/auth/invitations/preview', undefined, { token })).status).toBe(200);
    nameOf[company.id] = 'Taller Nuevo';
    expect((await del(company.id)).status).toBe(200);
    const preview = await call('POST', '/auth/invitations/preview', undefined, { token });
    const accept = await call('POST', '/auth/invitations/accept', undefined, { token, password: 'Nueva-Clave-9!', full_name: 'Dora Quinde', phone: '+593987654321' });
    expect([preview.status, accept.status]).toEqual([400, 400]);
    expect([await codeOf(preview), await codeOf(accept)]).toEqual(['INVALID_INVITATION', 'INVALID_INVITATION']);
    expect((await admin.query(`SELECT count(*)::int AS n FROM users WHERE email = 'dueno@taller.test'`)).rows[0].n).toBe(0);
    expect((await recover(company.id)).status).toBe(200);
    expect((await call('POST', '/auth/invitations/preview', undefined, { token })).status).toBe(200);
  });
});

describe('recuperar', () => {
  it('contraseña incorrecta 403; una empresa que no está eliminada es 404', async () => {
    expect((await recover(ORG_A)).status).toBe(404); // aún activa
    await del(ORG_A);
    const bad = await recover(ORG_A, { password: 'No-Es-La-Clave-1' });
    expect(bad.status).toBe(403);
    expect(await codeOf(bad)).toBe('PASSWORD_INVALID');
    expect(await status(ORG_A)).toMatchObject({ status: 'deleted' });
  });

  it('vuelve a su estado anterior (activa o suspendida), cierra la eliminación, avisa y audita; las sesiones viejas no reviven pero se puede entrar de nuevo', async () => {
    await admin.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ORG_B]);
    nameOf[ORG_B] = 'Estudio Luna';
    const aliceToken = await login('alice@a.test');
    await del(ORG_A);
    await del(ORG_B);
    const r = await recover(ORG_A);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ id: ORG_A, state: 'active', notified: 1, skipped: { scheduled_messages: 0, appointment_reminders: 0, automation_waits: 0, meta_events: 0 } });
    expect(await status(ORG_A)).toMatchObject({ status: 'active', deleted_at: null });
    const rb = await recover(ORG_B);
    expect(await json(rb)).toMatchObject({ id: ORG_B, state: 'suspended' }); // como estaba
    expect(await status(ORG_B)).toMatchObject({ status: 'suspended', deleted_at: null });
    expect((await call('GET', '/probe/business', aliceToken)).status).toBe(401); // la sesión anterior no revive
    const fresh = await login('alice@a.test');
    expect((await call('GET', '/probe/business', fresh)).status).toBe(200);
    const row = (await admin.query(`SELECT state, recovered_by, recovered_at FROM organization_deletions WHERE organization_id = $1`, [ORG_A])).rows[0];
    expect(row).toMatchObject({ state: 'recovered', recovered_by: IDS.root });
    expect(row.recovered_at).not.toBeNull();
    expect(mail.companyRecoveredOutbox.map((m) => [m.to, m.organizationName])).toContainEqual(['alice@a.test', 'Barbería Norte']);
    expect((await admin.query(`SELECT action FROM platform_audit WHERE action = 'company.recovered' AND target_org_id = $1`, [ORG_A])).rows).toHaveLength(1);
    // Ya recuperada: no se puede recuperar otra vez, pero se puede volver a eliminar (otra fila, la anterior queda como historia)
    expect((await recover(ORG_A)).status).toBe(404);
    expect((await del(ORG_A)).status).toBe(200);
    expect((await admin.query(`SELECT state FROM organization_deletions WHERE organization_id = $1 ORDER BY requested_at`, [ORG_A])).rows.map((x) => x.state)).toEqual(['recovered', 'scheduled']);
  });

  it('pasado el plazo ya no se recupera (409 RECOVERY_WINDOW_CLOSED) y la empresa sigue eliminada', async () => {
    await del(ORG_A);
    await admin.query(`UPDATE organization_deletions SET requested_at = now() - interval '8 days', purge_after = now() - interval '1 day' WHERE organization_id = $1`, [ORG_A]);
    const r = await recover(ORG_A);
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe('RECOVERY_WINDOW_CLOSED');
    expect(await status(ORG_A)).toMatchObject({ status: 'deleted' });
  });

  it('una eliminación que el borrado definitivo ya tomó no se recupera (409 NOT_RECOVERABLE)', async () => {
    await del(ORG_A);
    await admin.query(`UPDATE organization_deletions SET state = 'purging' WHERE organization_id = $1`, [ORG_A]);
    const r = await recover(ORG_A);
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe('NOT_RECOVERABLE');
  });

  it('lo que venció durante la pausa se deja «omitido» y lo que aún no venció sigue su curso; solo en la empresa recuperada', async () => {
    const mkContact = async (org: string) => {
      const id = uuidv7();
      await admin.query(`INSERT INTO contacts(id, organization_id, name) VALUES ($1,$2,'Cliente')`, [id, org]);
      return id;
    };
    const mkEvent = async (org: string, contact: string, ageDays: number) => {
      const id = uuidv7();
      await admin.query(`INSERT INTO meta_events(id, organization_id, event_id, type, contact_id, status, send_after, payload, created_at) VALUES ($1,$2,$3,'Lead',$4,'pending', now(), '{}'::jsonb, now() - make_interval(days => $5))`, [id, org, `ev-${id}`, contact, ageDays]);
      return id;
    };
    const mkWait = async (org: string, contact: string, dueInMinutes: number) => {
      const auto = uuidv7();
      await admin.query(`INSERT INTO automations(id, organization_id, name, status, trigger_type) VALUES ($1,$2,$3,'active','contact_created')`, [auto, org, `Regla ${auto}`]);
      const id = uuidv7();
      await admin.query(
        `INSERT INTO automation_runs(id, organization_id, automation_id, contact_id, event_type, event_key, status, next_attempt_at, resume_actions) VALUES ($1,$2,$3,$4,'contact_created',$5,'queued', now() + make_interval(mins => $6), '[{"type":"add_tag"}]'::jsonb)`,
        [id, org, auto, contact, `k-${id}`, dueInMinutes],
      );
      return id;
    };
    const cA = await mkContact(ORG_A);
    const cB = await mkContact(ORG_B);
    const oldA = await mkEvent(ORG_A, cA, 9);
    const freshA = await mkEvent(ORG_A, cA, 1);
    const oldB = await mkEvent(ORG_B, cB, 9); // otra empresa: no se toca
    const dueWaitA = await mkWait(ORG_A, cA, -30);
    const futureWaitA = await mkWait(ORG_A, cA, 60);
    const dueWaitB = await mkWait(ORG_B, cB, -30);
    await del(ORG_A);
    const r = await recover(ORG_A);
    expect(await json<{ skipped: Record<string, number> }>(r)).toMatchObject({ skipped: { meta_events: 1, automation_waits: 1 } });
    const ev = async (id: string) => (await admin.query(`SELECT status, last_error FROM meta_events WHERE id = $1`, [id])).rows[0];
    expect(await ev(oldA)).toMatchObject({ status: 'expired', last_error: 'pausa' });
    expect(await ev(freshA)).toMatchObject({ status: 'pending' });
    expect(await ev(oldB)).toMatchObject({ status: 'pending' });
    const run = async (id: string) => (await admin.query(`SELECT status, reason, finished_at FROM automation_runs WHERE id = $1`, [id])).rows[0];
    expect(await run(dueWaitA)).toMatchObject({ status: 'skipped', reason: 'pausa' });
    expect((await run(dueWaitA)).finished_at).not.toBeNull();
    expect(await run(futureWaitA)).toMatchObject({ status: 'queued' });
    expect(await run(dueWaitB)).toMatchObject({ status: 'queued' });
  });
});

describe('el dueño de la empresa (ADR-59 #7)', () => {
  it('aceptar la invitación del dueño lo registra como dueño', async () => {
    const created = await call('POST', '/platform/companies', rootToken, { name: 'Taller Nuevo', owner_email: 'dueno@taller.test', timezone: 'America/Guayaquil', country: 'EC' });
    const company = (await json<{ company: { id: string } }>(created)).company;
    expect((await admin.query(`SELECT owner_user_id FROM organizations WHERE id = $1`, [company.id])).rows[0].owner_user_id).toBeNull();
    const token = mail.lastInvitationToken('dueno@taller.test');
    const acc = await call('POST', '/auth/invitations/accept', undefined, { token, password: 'Nueva-Clave-9!', full_name: 'Dora Quinde', phone: '+593987654321' });
    expect(acc.status).toBe(200);
    const owner = (await admin.query(`SELECT id FROM users WHERE email = 'dueno@taller.test'`)).rows[0].id;
    expect((await admin.query(`SELECT owner_user_id FROM organizations WHERE id = $1`, [company.id])).rows[0].owner_user_id).toBe(owner);
  });
});
