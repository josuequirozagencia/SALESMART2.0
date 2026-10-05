import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTableName } from 'drizzle-orm';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate';
import { PLATFORM_FIXTURES, TENANT_FIXTURES } from '../fixtures/schema';
import { ORG_A, ORG_B, CONTACT_A1, CONTACT_A2, CONTACT_B1, DEAL_A1, DEAL_B1, TEST_PASSWORDS } from './constants';

export interface TestDbInfo {
  name: string;
  adminUrl: string; // superusuario → base "postgres"
  adminDbUrl: string; // superusuario → base de test (bypassa RLS: solo para verificar)
  ownerUrl: string;
  rwUrl: string;
  platformUrl: string;
  identityUrl: string;
  fixtureSql: string;
}
declare module 'vitest' {
  export interface ProvidedContext {
    testDb: TestDbInfo | null;
  }
}

const API_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(API_ROOT, '../..');

export function urlFor(base: string, user: string, password: string, db: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

/** Crea una base vacía con roles + migraciones aplicadas (sin fixtures). Reutilizable por los tests. */
export async function createMigratedDb(adminUrl: string, name: string): Promise<{ ownerUrl: string; rwUrl: string; platformUrl: string; identityUrl: string; adminDbUrl: string }> {
  execFileSync('bash', [path.join(REPO_ROOT, 'scripts/db-bootstrap.sh')], {
    env: {
      ...process.env,
      DB_ADMIN_URL: adminUrl,
      DB_NAME: name,
      APP_OWNER_PASSWORD: TEST_PASSWORDS.owner,
      APP_RW_PASSWORD: TEST_PASSWORDS.rw,
      APP_PLATFORM_PASSWORD: TEST_PASSWORDS.platform,
      APP_IDENTITY_PASSWORD: TEST_PASSWORDS.identity,
    },
    stdio: 'pipe',
  });
  const ownerUrl = urlFor(adminUrl, 'app_owner', TEST_PASSWORDS.owner, name);
  await runMigrations(ownerUrl);
  return {
    ownerUrl,
    rwUrl: urlFor(adminUrl, 'app_rw', TEST_PASSWORDS.rw, name),
    platformUrl: urlFor(adminUrl, 'app_platform', TEST_PASSWORDS.platform, name),
    identityUrl: urlFor(adminUrl, 'app_identity', TEST_PASSWORDS.identity, name),
    adminDbUrl: urlFor(adminUrl, new URL(adminUrl).username, decodeURIComponent(new URL(adminUrl).password), name),
  };
}

export async function dropDb(adminUrl: string, name: string): Promise<void> {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

/** Genera con drizzle-kit el DDL de las tablas de fixtures usando los helpers de producción. */
function generateFixtureSql(): string {
  const out = mkdtempSync(path.join(os.tmpdir(), 'ss-fixture-'));
  try {
    execFileSync('pnpm', ['exec', 'drizzle-kit', 'generate', '--dialect=postgresql', `--schema=${path.join(API_ROOT, 'test/fixtures/schema.ts')}`, `--out=${out}`], { cwd: API_ROOT, stdio: 'pipe' });
    return readdirSync(out)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(path.join(out, f), 'utf8'))
      .join('\n');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = process.env['TEST_PG_ADMIN_URL'];
  if (!adminUrl) {
    project.provide('testDb', null); // los tests de BD fallarán con un mensaje claro (requireDb)
    return async () => undefined;
  }
  const name = `ss_test_${randomBytes(4).toString('hex')}`;
  const urls = await createMigratedDb(adminUrl, name);
  const fixtureSql = generateFixtureSql();

  const owner = new Client({ connectionString: urls.ownerUrl });
  await owner.connect();
  try {
    for (const stmt of fixtureSql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) await owner.query(stmt);
    // Endurecimiento que las migraciones de producción escriben a mano (FORCE + GRANT); `db:audit` lo verifica.
    for (const t of TENANT_FIXTURES) {
      const n = getTableName(t);
      await owner.query(`ALTER TABLE "${n}" FORCE ROW LEVEL SECURITY`);
      await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${n}" TO app_rw`);
    }
    for (const t of PLATFORM_FIXTURES) await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${getTableName(t)}" TO app_platform`);
  } finally {
    await owner.end();
  }

  // Semillas con el rol real de la app y RLS activo (set_config local a la transacción)
  const rw = new Client({ connectionString: urls.rwUrl });
  await rw.connect();
  try {
    const seed = async (org: string, sqls: Array<[string, unknown[]]>) => {
      await rw.query('BEGIN');
      await rw.query(`SELECT set_config('app.org_id', $1, true)`, [org]);
      for (const [q, p] of sqls) await rw.query(q, p);
      await rw.query('COMMIT');
    };
    await seed(ORG_A, [
      [`INSERT INTO contacts(id, name) VALUES ($1, 'Ana (A)'), ($2, 'Alberto (A)')`, [CONTACT_A1, CONTACT_A2]],
      [`INSERT INTO deals(id, contact_id, amount) VALUES ($1, $2, 100.00)`, [DEAL_A1, CONTACT_A1]],
    ]);
    await seed(ORG_B, [
      [`INSERT INTO contacts(id, name) VALUES ($1, 'Beto (B)')`, [CONTACT_B1]],
      [`INSERT INTO deals(id, contact_id, amount) VALUES ($1, $2, 999.00)`, [DEAL_B1, CONTACT_B1]],
    ]);
  } finally {
    await rw.end();
  }

  project.provide('testDb', { name, adminUrl, fixtureSql, ...urls });
  return async () => dropDb(adminUrl, name);
}
