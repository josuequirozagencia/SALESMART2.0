// PgBouncer en modo TRANSACCIÓN (ADR-24 §3: el contexto es local a la transacción, así que debe ser compatible).
// Arranca un pgbouncer real y efímero delante de la BD de test. Si el binario no existe: se omite, salvo
// REQUIRE_PGBOUNCER=1 (CI), donde su ausencia es un fallo.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../src/db';
import { createLogger } from '../../src/logger';
import { contacts } from '../fixtures/schema';
import { ORG_A, ORG_B, ORG_C, TEST_PASSWORDS } from '../support/constants';
import { asOrg, requireDb, sleep } from '../support/harness';

const HAVE = spawnSync('pgbouncer', ['--version']).status === 0;
if (!HAVE && process.env['REQUIRE_PGBOUNCER'] === '1') throw new Error('REQUIRE_PGBOUNCER=1 pero no hay binario pgbouncer');

const info = requireDb();
let proc: ChildProcess | undefined;
let dir = '';
let port = 0;
let db: Database;
const pools: Pool[] = [];

const freePort = () => new Promise<number>((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const via = (user: string, pw: string) => `postgresql://${user}:${pw}@127.0.0.1:${port}/ss`;

beforeAll(async () => {
  if (!HAVE) return;
  dir = mkdtempSync(path.join(os.tmpdir(), 'ss-pgb-'));
  port = await freePort();
  const pg = new URL(info.adminUrl);
  writeFileSync(path.join(dir, 'userlist.txt'), Object.entries({ app_rw: TEST_PASSWORDS.rw, app_platform: TEST_PASSWORDS.platform, app_identity: TEST_PASSWORDS.identity }).map(([u, p]) => `"${u}" "${p}"`).join('\n') + '\n', { mode: 0o644 }); // credenciales SOLO de prueba; legible para el usuario no-root de pgbouncer
  writeFileSync(path.join(dir, 'pgbouncer.ini'), [
    '[databases]', `ss = host=${pg.hostname} port=${pg.port || 5432} dbname=${info.name}`,
    '[pgbouncer]', 'listen_addr = 127.0.0.1', `listen_port = ${port}`, `unix_socket_dir = ${dir}`,
    'auth_type = scram-sha-256', `auth_file = ${path.join(dir, 'userlist.txt')}`,
    'pool_mode = transaction', 'default_pool_size = 2', 'max_client_conn = 200', 'server_reset_query =', `logfile = ${path.join(dir, 'pgb.log')}`, `pidfile = ${path.join(dir, 'pgb.pid')}`,
  ].join('\n'));
  chmodSync(dir, 0o777); // directorio temporal de prueba: el usuario no-root de pgbouncer escribe log y pid
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0; // pgbouncer se niega a correr como root
  proc = spawn('pgbouncer', [...(asRoot ? ['-u', 'postgres'] : []), path.join(dir, 'pgbouncer.ini')], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const c = new Client({ connectionString: via('app_rw', TEST_PASSWORDS.rw) }); await c.connect(); await c.end(); break; } catch { await sleep(100); }
    if (i === 49) throw new Error('pgbouncer no arrancó');
  }
  const mk = (u: string, pw: string, max: number) => { const p = new Pool({ connectionString: via(u, pw), max }); pools.push(p); return p; };
  db = new Database({ app: mk('app_rw', TEST_PASSWORDS.rw, 12), platform: mk('app_platform', TEST_PASSWORDS.platform, 2), identity: mk('app_identity', TEST_PASSWORDS.identity, 2) }, createLogger({ level: 'silent' }));
});
afterAll(async () => {
  if (db) await db.close();
  proc?.kill('SIGTERM');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAVE)('compatibilidad con PgBouncer (modo transacción, 2 conexiones de servidor para 12 de cliente)', () => {
  it('300 transacciones intercaladas de 3 orgs: cero fugas de contexto', async () => {
    const orgs = [ORG_A, ORG_B, ORG_C];
    const leaks: string[] = [];
    await Promise.all(Array.from({ length: 300 }, (_, i) => {
      const org = orgs[i % 3]!;
      return asOrg(org, () => db.withTenant(async (tx) => {
        await sleep(Math.random() * 10);
        for (const r of await tx.select().from(contacts)) if (r.organizationId !== org) leaks.push(`${org} vio ${r.organizationId}`);
      }));
    }));
    expect(leaks).toEqual([]);
  });
  it('canario: tras las transacciones, ninguna conexión de servidor conserva app.org_id', async () => {
    const c = new Client({ connectionString: via('app_rw', TEST_PASSWORDS.rw) });
    await c.connect();
    try {
      for (let i = 0; i < 30; i++) expect((await c.query(`SELECT current_setting('app.org_id', true) AS v`)).rows[0].v ?? '').toBe('');
    } finally { await c.end(); }
  });
  it('sin contexto, a través del pooler, sigue fallando cerrado', async () => {
    const c = new Client({ connectionString: via('app_rw', TEST_PASSWORDS.rw) });
    await c.connect();
    try { expect((await c.query('SELECT * FROM contacts')).rowCount).toBe(0); } finally { await c.end(); }
  });
  it('withIdentity también funciona a través del pooler', async () => {
    await expect(db.withIdentity((tx) => tx.execute('SELECT 1' as never))).resolves.toBeDefined();
  });
});
