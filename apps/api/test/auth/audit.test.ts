// M1.4 — auditoría: audit_logs (cliente, RLS, append-only) y platform_audit (plataforma, append-only).
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { configureApp, HttpModule } from '../../src/http';
import { AuditService, writeAudit } from '../../src/modules/audit';
import { AuthModule, LocalAccessResolver } from '../../src/modules/auth';
import { PlatformAuditService } from '../../src/modules/platform';
import { Argon2idHasher } from '../../src/security';
import { TenantContext } from '../../src/tenant';
import { ORG_A, ORG_B, TEST_AUTH_KEY, USER_1 } from '../support/constants';
import { asOrg, asPlatform, makeRig, requireDb, type TestRig } from '../support/harness';

const info = requireDb();
const E1 = 'e1111111-1111-4111-8111-111111111111';
const E2 = 'e2222222-2222-4222-8222-222222222222';
let admin: Client;
let rig: TestRig;
beforeAll(async () => { admin = new Client({ connectionString: info.adminDbUrl }); await admin.connect(); rig = makeRig(); });
afterAll(async () => { await rig.close(); await admin.end(); });
beforeEach(async () => { await admin.query('TRUNCATE audit_logs, platform_audit'); });

describe('audit_logs (cliente)', () => {
  it('registra en la organización del contexto con actor, request_id y source; el llamador no elige la organización', async () => {
    await asOrg(ORG_A, () => rig.db.withTenant((tx) => writeAudit(tx, { entityType: 'contact', entityId: E1, field: 'name', oldValue: 'Ana', newValue: 'Ana María' })));
    const rows = (await admin.query('SELECT * FROM audit_logs')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organization_id: ORG_A, entity_type: 'contact', entity_id: E1, field: 'name', old_value: 'Ana', new_value: 'Ana María', actor_user_id: USER_1, source: 'manual', acting_as: null });
    expect(rows[0].request_id).toBeTruthy();
    expect(rows[0].at).toBeInstanceOf(Date);
  });

  it('A↔B: cada organización ve solo su auditoría (RLS) y no puede insertar en la ajena', async () => {
    await asOrg(ORG_A, () => rig.db.withTenant((tx) => writeAudit(tx, { entityType: 'contact', entityId: E1 })));
    await asOrg(ORG_B, () => rig.db.withTenant((tx) => writeAudit(tx, { entityType: 'contact', entityId: E2 })));
    const seen = async (org: string) => (await asOrg(org, () => rig.db.withTenant((tx) => tx.execute(`SELECT entity_id FROM audit_logs` as never)))) as unknown as { rows: Array<{ entity_id: string }> };
    expect((await seen(ORG_A)).rows.map((r) => r.entity_id)).toEqual([E1]);
    expect((await seen(ORG_B)).rows.map((r) => r.entity_id)).toEqual([E2]);
    // INSERT con organization_id ajeno: lo bloquea WITH CHECK
    const c = new Client({ connectionString: info.rwUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
      await expect(c.query(`INSERT INTO audit_logs(organization_id,id,entity_type,entity_id,source) VALUES ($1, gen_random_uuid(), 'contact', $2, 'manual')`, [ORG_B, E1])).rejects.toThrow(/row-level security/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); await c.end(); }
  });

  it('acting_as / acting_org_id (Súper Admin o agencia actuando dentro del cliente) quedan marcados', async () => {
    const AG = 'a9999999-9999-4999-8999-999999999999';
    await TenantContext.run({ organizationId: ORG_A, userId: USER_1, actingAs: 'agency', actingOrgId: AG }, () => rig.db.withTenant((tx) => writeAudit(tx, { entityType: 'contact', entityId: E1, source: 'api' })));
    expect((await admin.query('SELECT acting_as, acting_org_id, source FROM audit_logs')).rows[0]).toEqual({ acting_as: 'agency', acting_org_id: AG, source: 'api' });
  });

  it('campos sensibles se registran SIN valor; los demás conservan el valor', async () => {
    await asOrg(ORG_A, () => rig.db.withTenant(async (tx) => {
      await writeAudit(tx, { entityType: 'user', entityId: E1, field: 'password', oldValue: 'vieja-123', newValue: 'nueva-456' });
      await writeAudit(tx, { entityType: 'channel', entityId: E1, field: 'api_token', oldValue: 'abc', newValue: 'def' });
      await writeAudit(tx, { entityType: 'contact', entityId: E1, field: 'city', oldValue: 'Quito', newValue: 'Guayaquil' });
    }));
    const rows = (await admin.query('SELECT field, old_value, new_value FROM audit_logs ORDER BY field')).rows;
    const dump = JSON.stringify(rows);
    expect(dump).not.toMatch(/vieja-123|nueva-456|"abc"|"def"/);
    expect(rows.find((r) => r.field === 'password')).toMatchObject({ old_value: { redacted: true }, new_value: { redacted: true } });
    expect(rows.find((r) => r.field === 'city')).toMatchObject({ old_value: 'Quito', new_value: 'Guayaquil' });
  });

  it('atómica con el cambio auditado: si la transacción se revierte, la auditoría también', async () => {
    await expect(asOrg(ORG_A, () => rig.db.withTenant(async (tx) => { await writeAudit(tx, { entityType: 'contact', entityId: E1 }); throw new RangeError('falla el negocio'); }))).rejects.toBeInstanceOf(RangeError);
    expect((await admin.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n).toBe(0);
  });

  it('sin TenantContext no se puede auditar', async () => {
    await expect(rig.db.withTenant((tx) => writeAudit(tx, { entityType: 'contact', entityId: E1 }))).rejects.toThrow();
    expect((await admin.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n).toBe(0);
  });

  it('APPEND-ONLY: app_rw no puede UPDATE, DELETE ni TRUNCATE; y app_platform/app_identity no la ven', async () => {
    await asOrg(ORG_A, () => rig.db.withTenant((tx) => writeAudit(tx, { entityType: 'contact', entityId: E1 })));
    const rw = new Client({ connectionString: info.rwUrl });
    await rw.connect();
    try {
      for (const q of ['UPDATE audit_logs SET field = $1', 'DELETE FROM audit_logs', 'TRUNCATE audit_logs']) {
        await expect(rw.query(q, q.startsWith('UPDATE') ? ['x'] : []), q).rejects.toThrow(/permission denied/);
      }
    } finally { await rw.end(); }
    for (const url of [info.platformUrl, info.identityUrl]) {
      const c = new Client({ connectionString: url });
      await c.connect();
      try { await expect(c.query('SELECT 1 FROM audit_logs')).rejects.toThrow(/permission denied/); } finally { await c.end(); }
    }
    expect((await admin.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n).toBe(1);
  });

  it('restricciones de datos: source, acting_as y entity_type inválidos se rechazan', async () => {
    const bad = (cols: string, vals: unknown[]) => admin.query(`INSERT INTO audit_logs(organization_id,id,entity_type,entity_id,source${cols}) VALUES ($1, gen_random_uuid(), $2, $3, $4${vals.length > 4 ? ', $5' : ''})`, vals);
    await expect(bad('', [ORG_A, 'contact', E1, 'hackeado'])).rejects.toThrow(/audit_logs_source_valid/);
    await expect(bad(', acting_as', [ORG_A, 'contact', E1, 'manual', 'dios'])).rejects.toThrow(/audit_logs_acting_as_valid/);
    await expect(bad('', [ORG_A, 'Contact; DROP', E1, 'manual'])).rejects.toThrow(/audit_logs_entity_type_shape/);
  });

  it('AuditService.record abre su propia transacción de tenant', async () => {
    await asOrg(ORG_B, () => new AuditService(rig.db).record({ entityType: 'tag', entityId: E2, source: 'automation' }));
    expect((await admin.query('SELECT organization_id, source FROM audit_logs')).rows).toEqual([{ organization_id: ORG_B, source: 'automation' }]);
  });
});

describe('platform_audit (plataforma)', () => {
  it('registra con el actor del PlatformContext y descarta claves secretas de details', async () => {
    await asPlatform(() => new PlatformAuditService(rig.db).record({ action: 'trial.extension.approved', entityType: 'trial', entityId: E1, targetOrgId: ORG_A, details: { days: 3, token: 'SECRETO', api_key: 'K' } }));
    const row = (await admin.query('SELECT * FROM platform_audit')).rows[0];
    expect(row).toMatchObject({ action: 'trial.extension.approved', actor_user_id: USER_1, target_org_id: ORG_A, details: { days: 3 } });
    expect(JSON.stringify(row)).not.toMatch(/SECRETO/);
  });

  it('exige PlatformContext (sin él falla y no inserta)', async () => {
    await expect(new PlatformAuditService(rig.db).record({ action: 'x' })).rejects.toThrow();
    await expect(TenantContext.run({ organizationId: ORG_A, userId: USER_1 }, () => new PlatformAuditService(rig.db).record({ action: 'x' }))).rejects.toThrow();
    expect((await admin.query('SELECT count(*)::int AS n FROM platform_audit')).rows[0].n).toBe(0);
  });

  it('APPEND-ONLY y aislada: app_platform solo SELECT/INSERT; app_rw e identidad no la ven', async () => {
    await asPlatform(() => new PlatformAuditService(rig.db).record({ action: 'a' }));
    const pl = new Client({ connectionString: info.platformUrl });
    await pl.connect();
    try {
      for (const q of ["UPDATE platform_audit SET action = 'b'", 'DELETE FROM platform_audit', 'TRUNCATE platform_audit']) await expect(pl.query(q), q).rejects.toThrow(/permission denied/);
      expect((await pl.query('SELECT count(*)::int AS n FROM platform_audit')).rows[0].n).toBe(1);
    } finally { await pl.end(); }
    for (const url of [info.rwUrl, info.identityUrl]) {
      const c = new Client({ connectionString: url });
      await c.connect();
      try { await expect(c.query('SELECT 1 FROM platform_audit')).rejects.toThrow(/permission denied/); } finally { await c.end(); }
    }
  });
});

// ── La auditoría se usa de verdad: cambiar la contraseña deja rastro SIN la contraseña ─────────────────────
@Module({ imports: [CoreModule, DbModule, AuthModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

describe('cambio de contraseña audita sin valores', () => {
  let app: INestApplication;
  let base = '';
  const PW = 'Correct-Horse-9!';
  const NEW = 'Nueva-Clave-2026';
  const saved = { ...process.env };
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY });
    delete process.env['DATABASE_URL_OWNER'];
    app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/v1`;
  });
  afterAll(async () => { await app.close(); process.env = saved; });

  it('cliente → audit_logs (organización del cliente); Súper Admin → platform_audit; la contraseña no aparece en ninguno', async () => {
    const hash = await new Argon2idHasher().hash(PW);
    const PLAT = '00000000-0000-4000-8000-0000000000f0';
    await admin.query('TRUNCATE sessions, auth_throttle, organization_members, organizations, users CASCADE');
    for (const [id, kind, name] of [[PLAT, 'platform', 'P'], [ORG_A, 'client', 'A']]) await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,$2,$3,'UTC')`, [id, kind, name]);
    const U = { cli: 'c1000000-0000-4000-8000-000000000001', root: 'c1000000-0000-4000-8000-000000000002' };
    for (const [id, email, org, role] of [[U.cli, 'cli@a.test', ORG_A, 'client_admin'], [U.root, 'root@p.test', PLAT, 'super_admin']]) {
      await admin.query(`INSERT INTO users(id,email,password_hash,status,email_verified_at) VALUES ($1,$2,$3,'active',now())`, [id, email, hash]);
      await admin.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [id, org, role]);
    }
    for (const email of ['cli@a.test', 'root@p.test']) {
      const l = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW, token_transport: 'body' }) });
      const t = ((await l.json()) as { access_token: string }).access_token;
      const r = await fetch(`${base}/auth/password`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify({ current_password: PW, new_password: NEW }) });
      expect(r.status).toBe(204);
    }
    const a = (await admin.query('SELECT * FROM audit_logs')).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ organization_id: ORG_A, entity_type: 'user', entity_id: U.cli, field: 'password', actor_user_id: U.cli, old_value: { redacted: true }, new_value: { redacted: true } });
    const p = (await admin.query('SELECT * FROM platform_audit')).rows;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ action: 'user.password_changed', entity_id: U.root, actor_user_id: U.root });
    expect(JSON.stringify([a, p])).not.toMatch(new RegExp(`${PW}|${NEW}`));
  });
});
