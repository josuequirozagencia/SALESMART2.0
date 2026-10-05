// M1.4 — RBAC: catálogo, matriz rol→permisos (BD = código), guard central y efecto inmediato de cambios de rol.
import 'reflect-metadata';
import { Controller, Get, Module, Post, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule, PlatformOnly } from '../../src/http';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { PermissionService } from '../../src/modules/auth/permission.service';
import { PERMISSION_KEYS, PERMISSIONS, RequirePermission, ROLE_PERMISSIONS, ROLES } from '../../src/rbac';
import { Argon2idHasher } from '../../src/security';
import { ORG_A, ORG_B, TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Controller('probe')
class ProbeController {
  @Get('contacts') @RequirePermission('contacts.read') contacts() { return { ok: 'contacts.read' }; }
  @Post('pipelines') @RequirePermission('pipelines.manage') pipelines() { return { ok: 'pipelines.manage' }; }
  @Get('multi') @RequirePermission('contacts.read', 'export') multi() { return { ok: 'multi' }; }
  @Get('inbox-all') @RequirePermission('inbox.view_all') inboxAll() { return { ok: 'inbox.view_all' }; }
  @PlatformOnly() @RequirePermission('platform.trials.manage') @Get('trials') trials() { return { ok: 'platform.trials.manage' }; }
  @Get('open') open() { return { ok: 'sin permiso (solo autenticado)' }; }
}
@Module({ imports: [CoreModule, DbModule, AuthModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })], controllers: [ProbeController] })
class TestAppModule {}

const info = requireDb();
const PW = 'Correct-Horse-9!';
const IDS = { platformOrg: '00000000-0000-4000-8000-0000000000f0', admin: 'a0000000-0000-4000-8000-00000000000a', adv: 'a0000000-0000-4000-8000-0000000000a2', agency: 'a0000000-0000-4000-8000-0000000000a3', bobAdmin: 'b0000000-0000-4000-8000-00000000000b', root: 'f0000000-0000-4000-8000-0000000000f1' };
const EMAILS: Record<string, string> = { admin: 'admin@a.test', adv: 'adv@a.test', agency: 'agency@a.test', bobAdmin: 'bob@b.test', root: 'root@plat.test' };
let admin: Client;
let app: INestApplication;
let base = '';
let hash = '';
const saved = { ...process.env };

async function seed() {
  await admin.query('TRUNCATE sessions, auth_throttle, organization_members, organizations, users CASCADE');
  for (const [id, kind, name] of [[IDS.platformOrg, 'platform', 'Plataforma'], [ORG_A, 'client', 'Empresa A'], [ORG_B, 'client', 'Empresa B']]) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
  const members: Array<[string, string, string]> = [[IDS.admin, ORG_A, 'client_admin'], [IDS.adv, ORG_A, 'advisor'], [IDS.agency, ORG_A, 'agency'], [IDS.bobAdmin, ORG_B, 'client_admin'], [IDS.root, IDS.platformOrg, 'super_admin']];
  for (const [u, o, r] of members) {
    const email = Object.entries(IDS).find(([, v]) => v === u)![0];
    await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [u, EMAILS[email], hash]);
    await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, r]);
  }
}
beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  hash = await new Argon2idHasher().hash(PW);
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = `${await app.getUrl()}/v1`;
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(async () => { await seed(); app.get(PermissionService, { strict: false }).invalidate(); });

async function token(who: keyof typeof EMAILS): Promise<string> {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAILS[who], password: PW, token_transport: 'body' }) });
  expect(r.status).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}
const call = (method: string, path: string, t?: string, extra: Record<string, string> = {}, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('catálogo y matriz', () => {
  it('el catálogo contiene exactamente los permisos canónicos del Build Spec §5.2', () => {
    const spec = ['inbox.view_all', 'inbox.reply', 'inbox.transfer', 'inbox.share', 'contacts.read', 'contacts.write', 'contacts.import', 'contacts.export', 'opportunities.read', 'opportunities.write', 'pipelines.manage', 'sales.create', 'sales.cancel', 'appointments.manage', 'queues.manage', 'tags.manage', 'agents.manage', 'agents.test', 'knowledge.manage', 'channels.manage', 'integrations.manage', 'forms.manage', 'automations.manage', 'commissions.view', 'commissions.manage', 'analytics.view', 'export', 'team.manage', 'billing.manage', 'platform.providers.manage', 'platform.agencies.manage', 'platform.trials.manage', 'platform.access_log.read'];
    expect([...PERMISSION_KEYS].sort()).toEqual([...spec].sort());
  });

  it('la BD (roles, permisos, role_permissions) coincide EXACTAMENTE con el código: si divergen, falla', async () => {
    const roles = (await admin.query('SELECT key, scope FROM roles ORDER BY key')).rows;
    expect(roles).toEqual(Object.entries(ROLES).map(([key, v]) => ({ key, scope: v.scope })).sort((a, b) => a.key.localeCompare(b.key)));
    const perms = (await admin.query('SELECT key, scope FROM permissions ORDER BY key')).rows;
    expect(perms).toEqual(Object.entries(PERMISSIONS).map(([key, scope]) => ({ key, scope })).sort((a, b) => a.key.localeCompare(b.key)));
    const rp = (await admin.query('SELECT role_key, permission_key FROM role_permissions')).rows.map((r) => `${r.role_key}:${r.permission_key}`).sort();
    const expected = Object.entries(ROLE_PERMISSIONS).flatMap(([r, ps]) => ps.map((p) => `${r}:${p}`)).sort();
    expect(rp).toEqual(expected);
  });

  it('invariantes: plataforma solo para super_admin; client_admin = todos los de organización; asesor sin inbox.view_all ni gestión; agencia sin permisos propios en M1', () => {
    const tenant = PERMISSION_KEYS.filter((k) => PERMISSIONS[k] === 'tenant');
    const platform = PERMISSION_KEYS.filter((k) => PERMISSIONS[k] === 'platform');
    expect([...ROLE_PERMISSIONS.super_admin].sort()).toEqual([...platform].sort());
    expect([...ROLE_PERMISSIONS.client_admin].sort()).toEqual([...tenant].sort());
    for (const r of ['agency', 'client_admin', 'advisor'] as const) for (const p of ROLE_PERMISSIONS[r]) expect(PERMISSIONS[p]).toBe('tenant');
    expect(ROLE_PERMISSIONS.advisor).not.toContain('inbox.view_all');
    expect(ROLE_PERMISSIONS.advisor.filter((p) => p.endsWith('.manage') || p === 'export' || p.startsWith('platform.'))).toEqual([]);
    expect(ROLE_PERMISSIONS.agency).toEqual([]);
  });

  it('permisos de BD: app_identity solo lee; app_rw y app_platform no tocan roles/permisos', async () => {
    const id = new Client({ connectionString: info.identityUrl });
    const rw = new Client({ connectionString: info.rwUrl });
    const pl = new Client({ connectionString: info.platformUrl });
    await Promise.all([id.connect(), rw.connect(), pl.connect()]);
    try {
      expect((await id.query('SELECT count(*)::int AS n FROM role_permissions')).rows[0].n).toBeGreaterThan(0);
      for (const t of ['roles', 'permissions', 'role_permissions']) {
        await expect(id.query(`DELETE FROM ${t}`), t).rejects.toThrow(/permission denied/);
        await expect(id.query(`UPDATE ${t} SET key = key`).catch((e: Error) => { throw e; }), t).rejects.toThrow(/permission denied|column/);
        await expect(rw.query(`SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
        await expect(pl.query(`SELECT 1 FROM ${t}`), t).rejects.toThrow(/permission denied/);
      }
      await expect(id.query(`INSERT INTO role_permissions VALUES ('advisor','export')`)).rejects.toThrow(/permission denied/);
    } finally { await Promise.all([id.end(), rw.end(), pl.end()]); }
  });
});

describe('guard central de permisos', () => {
  it('sin token → 401; token válido sin permiso → 403 genérico', async () => {
    expect((await call('GET', '/probe/contacts')).status).toBe(401);
    const t = await token('adv');
    const r = await call('POST', '/probe/pipelines', t);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('asesor: solo su línea base (contacts.read ok; pipelines.manage, inbox.view_all y varios-permisos denegados)', async () => {
    const t = await token('adv');
    expect((await call('GET', '/probe/contacts', t)).status).toBe(200);
    expect((await call('POST', '/probe/pipelines', t)).status).toBe(403);
    expect((await call('GET', '/probe/inbox-all', t)).status).toBe(403);
    expect((await call('GET', '/probe/multi', t)).status).toBe(403); // exige contacts.read Y export
    expect((await call('GET', '/probe/open', t)).status).toBe(200);  // sin permiso declarado: solo autenticación
  });

  it('client_admin: todos los permisos de organización; ninguno de plataforma', async () => {
    const t = await token('admin');
    for (const [m, p] of [['GET', '/probe/contacts'], ['POST', '/probe/pipelines'], ['GET', '/probe/multi'], ['GET', '/probe/inbox-all']] as const) expect((await call(m, p, t)).status, p).toBeLessThan(300);
    expect((await call('GET', '/probe/trials', t)).status).toBe(403);
  });

  it('super_admin: permisos de plataforma en rutas de plataforma; las rutas de organización exigen contexto', async () => {
    const t = await token('root');
    expect((await call('GET', '/probe/trials', t)).status).toBe(200);
    const r = await call('GET', '/probe/contacts', t);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: { code: 'CONTEXT_REQUIRED' } });
  });

  it('agencia: sin permisos propios en M1 (todo permiso exigido se deniega)', async () => {
    const t = await token('agency');
    expect((await call('GET', '/probe/contacts', t)).status).toBe(403);
    expect((await call('GET', '/probe/open', t)).status).toBe(200);
  });

  it('el cliente no puede escalar: cabeceras o cuerpo con permisos/rol/organización se ignoran', async () => {
    const t = await token('adv');
    const r = await call('POST', '/probe/pipelines', t, { 'x-permissions': 'pipelines.manage', 'x-role': 'client_admin', 'x-org-id': ORG_B }, { permissions: ['pipelines.manage'], role: 'client_admin' });
    expect(r.status).toBe(403);
  });

  it('los permisos salen de la BD: quitar la fila de role_permissions deniega (tras invalidar la caché)', async () => {
    const t = await token('adv');
    expect((await call('GET', '/probe/contacts', t)).status).toBe(200);
    await admin.query(`DELETE FROM role_permissions WHERE role_key='advisor' AND permission_key='contacts.read'`);
    app.get(PermissionService, { strict: false }).invalidate();
    expect((await call('GET', '/probe/contacts', t)).status).toBe(403);
    await admin.query(`INSERT INTO role_permissions VALUES ('advisor','contacts.read')`); // restaura
  });

  it('cambio de rol con efecto inmediato: pasar de client_admin a advisor quita permisos en la siguiente petición', async () => {
    const t = await token('admin');
    expect((await call('POST', '/probe/pipelines', t)).status).toBe(201);
    await admin.query(`UPDATE organization_members SET role='advisor' WHERE user_id=$1`, [IDS.admin]);
    expect((await call('POST', '/probe/pipelines', t)).status).toBe(403);
    await admin.query(`UPDATE organization_members SET revoked_at=now() WHERE user_id=$1`, [IDS.admin]);
    expect((await call('GET', '/probe/contacts', t)).status).toBe(401); // membresía revocada: ya no autentica
  });

  it('defensa en profundidad: un permiso de plataforma mal sembrado a un rol de organización NO se concede', async () => {
    await admin.query(`INSERT INTO role_permissions VALUES ('client_admin','platform.trials.manage')`);
    const svc = app.get(PermissionService, { strict: false });
    svc.invalidate();
    expect((await svc.forRole('client_admin')).has('platform.trials.manage' as never)).toBe(false);
    expect((await call('GET', '/probe/trials', await token('admin'))).status).toBe(403);
    await admin.query(`DELETE FROM role_permissions WHERE role_key='client_admin' AND permission_key='platform.trials.manage'`);
  });

  it('un rol desconocido no tiene ningún permiso', async () => {
    const svc = app.get(PermissionService, { strict: false });
    expect((await svc.forRole('inventado')).size).toBe(0);
    expect((await svc.forRole(undefined)).size).toBe(0);
  });
});
