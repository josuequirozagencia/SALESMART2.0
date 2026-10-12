// ADR-35 — limpieza de tablas de identidad con una función SECURITY DEFINER (app_identity NO tiene DELETE).
import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoreModule } from '../../src/core.module';
import { DbModule } from '../../src/db';
import { HttpModule } from '../../src/http';
import { JobRunner, JobsModule } from '../../src/jobs';
import { AuthModule, IDENTITY_CLEANUP_BATCH, LocalAccessResolver } from '../../src/modules/auth';
import { OrganizationsModule } from '../../src/modules/organizations';
import { TEST_AUTH_KEY } from '../support/constants';
import { requireDb } from '../support/harness';

@Module({ imports: [CoreModule, DbModule, AuthModule, OrganizationsModule, JobsModule, HttpModule.forRoot({ accessResolver: LocalAccessResolver, imports: [AuthModule] })] })
class TestAppModule {}

const info = requireDb();
const HEX = 'ab'.repeat(32);
const ORG = '0c1ea000-0000-4000-8000-000000000001';
let admin: Client;
let app: INestApplication;
let jobs: JobRunner;
const saved = { ...process.env };

async function reset() {
  await admin.query('TRUNCATE sessions, auth_throttle, email_verifications, signup_attempts, password_resets, trials, organization_members, organizations, users CASCADE');
  await admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES ($1,'client','Org','UTC')`, [ORG]);
}

let seq = 0;
/** Usuario nuevo (cada fila de email_verifications / password_resets exige uno propio). */
async function user(): Promise<string> {
  const id = `0c1ea000-0000-4000-8000-${String(++seq).padStart(12, '0').replace(/^0/, '1')}`;
  await admin.query(`INSERT INTO users(id,email,password_hash,status) VALUES ($1,$2,$3,'pending')`, [id, `u${seq}@c.test`, '$argon2id$v=19$m=19456,t=2,p=1$x$y']);
  return id;
}
const ago = (interval: string) => `now() - interval '${interval}'`;

async function session(opts: { absolute: string; revoked?: string }): Promise<void> {
  const u = await user();
  await admin.query(
    `INSERT INTO sessions(id,user_id,active_org_id,user_session_version,access_hash,access_expires_at,refresh_hash,refresh_expires_at,absolute_expires_at,revoked_at,revoke_reason)
     VALUES (gen_random_uuid(),$1,$2,1,$3,now(),$3,now(),${opts.absolute},${opts.revoked ?? 'NULL'},${opts.revoked ? "'logout'" : 'NULL'})`,
    [u, ORG, HEX],
  );
}
async function verification(o: { expires: string; consumed?: string }): Promise<void> {
  await admin.query(`INSERT INTO email_verifications(id,user_id,code_hmac,expires_at,consumed_at,pending_org_name,pending_timezone) VALUES (gen_random_uuid(),$1,$2,${o.expires},${o.consumed ?? 'NULL'},'Org','UTC')`, [await user(), HEX]);
}
async function reset_(o: { expires: string; consumed?: string }): Promise<void> {
  await admin.query(`INSERT INTO password_resets(id,user_id,token_hash,expires_at,consumed_at) VALUES (gen_random_uuid(),$1,$2,${o.expires},${o.consumed ?? 'NULL'})`, [await user(), HEX]);
}
const throttleKey = (i: number) => `e:${i.toString(16).padStart(64, '0')}`;
const count = async (t: string) => (await admin.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number;

async function asIdentity<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: info.identityUrl });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

beforeAll(async () => {
  admin = new Client({ connectionString: info.adminDbUrl });
  await admin.connect();
  Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_APP: info.rwUrl, DATABASE_URL_PLATFORM: info.platformUrl, DATABASE_URL_IDENTITY: info.identityUrl, AUTH_THROTTLE_KEY: TEST_AUTH_KEY });
  delete process.env['DATABASE_URL_OWNER'];
  app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
  await app.init();
  jobs = app.get(JobRunner);
});
afterAll(async () => { await app.close(); await admin.end(); process.env = saved; });
beforeEach(reset);

describe('purge_expired_identity_rows', () => {
  it('borra SOLO lo caducado de cada tabla y conserva lo vivo o reciente', async () => {
    // sessions: vencida hace 8 d (se va), revocada hace 8 d (se va), revocada hace 1 d (se queda), vigente (se queda), vencida hace 1 d (se queda)
    await session({ absolute: ago('8 days') });
    await session({ absolute: "now() + interval '30 days'", revoked: ago('8 days') });
    await session({ absolute: "now() + interval '30 days'", revoked: ago('1 day') });
    await session({ absolute: "now() + interval '30 days'" });
    await session({ absolute: ago('1 day') });
    // auth_throttle: inactiva 8 d sin bloqueo (se va), inactiva 8 d con bloqueo vigente (se queda), reciente (se queda), inactiva 8 d con bloqueo ya vencido (se va)
    await admin.query(`INSERT INTO auth_throttle(key,failures,locked_until,updated_at) VALUES ($1,3,NULL,${ago('8 days')}), ($2,5,now() + interval '1 hour',${ago('8 days')}), ($3,1,NULL,now()), ($4,5,${ago('7 days 12 hours')},${ago('8 days')})`, [throttleKey(1), throttleKey(2), throttleKey(3), throttleKey(4)]);
    // email_verifications: vencida hace 8 d (se va), consumida hace 8 d (se va), vigente (se queda), vencida hace 1 d (se queda)
    await verification({ expires: ago('8 days') });
    await verification({ expires: "now() + interval '1 day'", consumed: ago('8 days') });
    await verification({ expires: "now() + interval '10 minutes'" });
    await verification({ expires: ago('1 day') });
    // signup_attempts: ventana de hace 2 d (se va), de hace 10 min (se queda)
    await admin.query(`INSERT INTO signup_attempts(key,count,window_started_at) VALUES ($1,4,${ago('2 days')}), ($2,1,${ago('10 minutes')})`, [`s:${HEX}`, `m:${HEX}`]);
    // password_resets: vencido hace 8 d (se va), consumido hace 8 d (se va), vigente (se queda), consumido ayer (se queda)
    await reset_({ expires: ago('8 days') });
    await reset_({ expires: "now() + interval '1 day'", consumed: ago('8 days') });
    await reset_({ expires: "now() + interval '20 minutes'" });
    await reset_({ expires: "now() + interval '1 day'", consumed: ago('1 day') });

    const res = await asIdentity((c) => c.query<{ table_name: string; purged: number }>('SELECT table_name, purged FROM purge_expired_identity_rows()'));
    expect(Object.fromEntries(res.rows.map((r) => [r.table_name, r.purged]))).toEqual({ sessions: 2, auth_throttle: 2, email_verifications: 2, signup_attempts: 1, password_resets: 2 });
    expect([await count('sessions'), await count('auth_throttle'), await count('email_verifications'), await count('signup_attempts'), await count('password_resets')]).toEqual([3, 2, 2, 1, 2]);
    // una segunda pasada ya no encuentra nada
    const again = await asIdentity((c) => c.query<{ purged: number }>('SELECT purged FROM purge_expired_identity_rows()'));
    expect(again.rows.every((r) => r.purged === 0)).toBe(true);
  });

  it('NUNCA toca usuarios, organizaciones ni membresías', async () => {
    await session({ absolute: ago('30 days') });
    await asIdentity((c) => c.query('SELECT * FROM purge_expired_identity_rows()'));
    expect(await count('sessions')).toBe(0);
    expect(await count('users')).toBe(1); // el dueño de la sesión sigue
    expect(await count('organizations')).toBe(1);
  });

  it('privilegios: solo app_identity la ejecuta; app_rw, app_platform y PUBLIC no; y app_identity sigue SIN DELETE directo', async () => {
    for (const [name, url] of [['app_rw', info.rwUrl], ['app_platform', info.platformUrl]] as const) {
      const c = new Client({ connectionString: url });
      await c.connect();
      try { await expect(c.query('SELECT * FROM purge_expired_identity_rows()'), name).rejects.toThrow(/permission denied/); } finally { await c.end(); }
    }
    await asIdentity(async (c) => {
      await expect(c.query('SELECT * FROM purge_expired_identity_rows()')).resolves.toBeTruthy();
      for (const q of ['DELETE FROM sessions', 'DELETE FROM users', 'TRUNCATE sessions']) await expect(c.query(q), q).rejects.toThrow(/permission denied/);
    });
  });

  it('no acepta parámetros (la app no puede pedirle que borre más) y su definición es segura', async () => {
    await asIdentity((c) => expect(c.query(`SELECT * FROM purge_expired_identity_rows(now() + interval '100 years')`)).rejects.toThrow(/does not exist/));
    const f = (await admin.query(`SELECT prosecdef, pg_get_userbyid(proowner) AS owner, proconfig, pronargs FROM pg_proc WHERE proname = 'purge_expired_identity_rows'`)).rows[0];
    expect(f).toMatchObject({ prosecdef: true, owner: 'app_owner', pronargs: 0 });
    expect(f.proconfig).toEqual(expect.arrayContaining([expect.stringMatching(/^search_path=pg_catalog, ?public$/)]));
  });

  it('SKIP LOCKED: una fila que otra transacción tiene bloqueada se salta (no espera) y se borra en la pasada siguiente', async () => {
    await session({ absolute: ago('9 days') });
    await session({ absolute: ago('9 days') });
    const other = new Client({ connectionString: info.adminDbUrl });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(`SELECT 1 FROM sessions WHERE id = (SELECT id FROM sessions ORDER BY id LIMIT 1) FOR UPDATE`);
      const t0 = Date.now();
      const r = await asIdentity((c) => c.query<{ table_name: string; purged: number }>('SELECT table_name, purged FROM purge_expired_identity_rows()'));
      expect(Date.now() - t0).toBeLessThan(3000); // no esperó el bloqueo
      expect(r.rows.find((x) => x.table_name === 'sessions')?.purged).toBe(1);
      await other.query('COMMIT');
    } finally {
      await other.end();
    }
    await asIdentity((c) => c.query('SELECT * FROM purge_expired_identity_rows()'));
    expect(await count('sessions')).toBe(0);
  });
});

describe('job identity-cleanup', () => {
  it('con más filas que un lote las limpia TODAS en una pasada (repite mientras el lote venga lleno)', async () => {
    const n = IDENTITY_CLEANUP_BATCH + 120;
    await admin.query(`INSERT INTO auth_throttle(key,failures,updated_at) SELECT 'e:' || lpad(to_hex(g), 64, '0'), 1, ${ago('9 days')} FROM generate_series(1, $1) g`, [n]);
    await admin.query(`INSERT INTO auth_throttle(key,failures,updated_at) VALUES ($1, 1, now())`, [throttleKey(999_999)]);
    expect(await jobs.runOnce('identity-cleanup')).toBe(n);
    expect(await count('auth_throttle')).toBe(1); // la reciente se conserva
  });

  it('dos ejecuciones simultáneas no se estorban ni borran de más', async () => {
    await admin.query(`INSERT INTO auth_throttle(key,failures,updated_at) SELECT 'e:' || lpad(to_hex(g), 64, '0'), 1, ${ago('9 days')} FROM generate_series(1, 3000) g`);
    const direct = await Promise.all([asIdentity((c) => c.query('SELECT * FROM purge_expired_identity_rows()')), asIdentity((c) => c.query('SELECT * FROM purge_expired_identity_rows()'))]);
    expect(direct).toHaveLength(2);
    expect(await count('auth_throttle')).toBe(0);
  });

  it('está registrado con su intervalo configurable y no hace nada con la tabla vacía', async () => {
    expect(await jobs.runOnce('identity-cleanup')).toBe(0);
  });
});
