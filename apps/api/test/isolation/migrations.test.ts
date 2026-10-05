// Migraciones: desde cero, idempotentes, sin cambios pendientes en drizzle-kit y sin construcciones prohibidas.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PRODUCTION_CATALOG } from '../../src/db/audit/catalog';
import { auditDatabase } from '../../src/db/audit/schema-audit';
import { runMigrations } from '../../src/db/migrate';
import { TENANT_FIXTURES } from '../fixtures/schema';
import { createMigratedDb, dropDb } from '../support/global-setup';
import { requireDb } from '../support/harness';
import { scanMigrationSql } from '../support/sql-scan';
import { getTableName } from 'drizzle-orm';

const info = requireDb();
const API_ROOT = path.resolve(__dirname, '../..');
const MIG_DIR = path.join(API_ROOT, 'src/db/migrations');
const created: string[] = [];
afterAll(async () => {
  for (const n of created) await dropDb(info.adminUrl, n);
});

describe('migraciones', () => {
  it('desde cero: aplican, son idempotentes y el esquema resultante cumple la auditoría de producción', async () => {
    const name = `ss_mig_${randomBytes(4).toString('hex')}`;
    created.push(name);
    const urls = await createMigratedDb(info.adminUrl, name);
    await runMigrations(urls.ownerUrl); // segunda ejecución: no hace nada
    const c = new Client({ connectionString: urls.ownerUrl });
    await c.connect();
    try {
      expect(await auditDatabase(c, PRODUCTION_CATALOG)).toEqual([]);
      const n = (await c.query(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)).rows[0].n;
      expect(n).toBe(readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).length);
    } finally {
      await c.end();
    }
  });

  it('el bootstrap de roles es idempotente (se puede repetir sin error)', () => {
    const name = created[0]!;
    expect(() => createMigratedDbSync(name)).not.toThrow();
  });

  it('`drizzle-kit generate` no detecta cambios pendientes (esquema y migraciones sincronizados)', () => {
    // drizzle-kit exige una ruta relativa para --out; se usa una copia temporal dentro del paquete
    const rel = `.tmp-mig-${randomBytes(4).toString('hex')}`;
    const tmp = path.join(API_ROOT, rel);
    try {
      cpSync(MIG_DIR, tmp, { recursive: true });
      const before = readdirSync(tmp).sort();
      const r = spawnSync('pnpm', ['exec', 'drizzle-kit', 'generate', '--dialect=postgresql', '--schema=./src/db/schema/index.ts', `--out=./${rel}`], { cwd: API_ROOT, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/No schema changes/i);
      expect(readdirSync(tmp).sort()).toEqual(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('SQL de migraciones sin construcciones prohibidas (USING true, SECURITY DEFINER, BYPASSRLS, locks de sesión...)', () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(scanMigrationSql(readFileSync(path.join(MIG_DIR, f), 'utf8'), [], PRODUCTION_CATALOG.identity), f).toEqual([]);
  });

  it('el escáner SQL tiene dientes: detecta cada construcción prohibida y tablas tenant sin FORCE/política', () => {
    const bad = [
      'CREATE POLICY p ON t USING (true);',
      'CREATE FUNCTION f() RETURNS int SECURITY DEFINER AS $$ select 1 $$ LANGUAGE sql;',
      'ALTER ROLE app_rw BYPASSRLS;',
      'ALTER TABLE t DISABLE ROW LEVEL SECURITY;',
      "SELECT set_config('app.org_id', 'x', false);",
      'SELECT pg_advisory_lock(1);',
      'CREATE ROLE evil;',
      'GRANT SELECT ON t TO PUBLIC;',
      'GRANT TRUNCATE ON t TO app_rw;',
      'CREATE TABLE "x" ("id" uuid, "organization_id" uuid);',
    ];
    for (const s of bad) expect(scanMigrationSql(s).length, s).toBeGreaterThan(0);
    // comentarios no cuentan, y una tabla tenant bien declarada pasa
    expect(scanMigrationSql('-- USING (true) SECURITY DEFINER\nSELECT 1;')).toEqual([]);
    expect(
      scanMigrationSql(`CREATE TABLE "y" ("organization_id" uuid);
ALTER TABLE "y" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "y" FORCE ROW LEVEL SECURITY;
CREATE POLICY "p" ON "y" AS PERMISSIVE FOR ALL TO public USING (organization_id = app_org());`),
    ).toEqual([]);
  });

  it('tenantTable() genera DDL correcto: ENABLE RLS, política USING/WITH CHECK app_org(), DEFAULT app_org(), UNIQUE (organization_id,id)', () => {
    const sqlText = info.fixtureSql;
    for (const t of TENANT_FIXTURES) {
      const n = getTableName(t);
      expect(sqlText, n).toMatch(new RegExp(`ALTER TABLE "${n}" ENABLE ROW LEVEL SECURITY`));
      expect(sqlText, n).toMatch(new RegExp(`CREATE POLICY "${n}_tenant_isolation" ON "${n}" AS PERMISSIVE FOR ALL TO public USING \\(organization_id = app_org\\(\\)\\) WITH CHECK \\(organization_id = app_org\\(\\)\\)`));
      expect(sqlText, n).toMatch(new RegExp(`CREATE TABLE "${n}" \\(\\s*"organization_id" uuid DEFAULT app_org\\(\\) NOT NULL`));
    }
    expect(sqlText).toMatch(/"contacts_org_id_uq" UNIQUE\("organization_id","id"\)/);
    expect(sqlText).toMatch(/FOREIGN KEY \("organization_id","contact_id"\) REFERENCES "public"."contacts"\("organization_id","id"\)/);
  });
});

function createMigratedDbSync(name: string): void {
  execFileSync('bash', [path.join(API_ROOT, '../../scripts/db-bootstrap.sh')], {
    env: { ...process.env, DB_ADMIN_URL: info.adminUrl, DB_NAME: name, APP_OWNER_PASSWORD: 'test-owner-pw', APP_RW_PASSWORD: 'test-rw-pw', APP_PLATFORM_PASSWORD: 'test-platform-pw', APP_IDENTITY_PASSWORD: 'test-identity-pw' },
    stdio: 'pipe',
  });
}
