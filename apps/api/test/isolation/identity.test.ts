// ADR-25: tablas de identidad fuera de RLS, accesibles solo por app_identity; integridad por CHECK/UNIQUE; bootstrap del super_admin.
import { Pool, Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Database, organizationMembers, organizations, users } from '../../src/db';
import { Argon2idHasher } from '../../src/security';
import { BootstrapError, bootstrapSuperAdmin } from '../../src/modules/auth';
import { createLogger } from '../../src/logger';
import { rejection, requireDb } from '../support/harness';

const info = requireDb();
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';
let ident: Client;
let rw: Client;
let platform: Client;
let admin: Client;

beforeAll(async () => {
  ident = new Client({ connectionString: info.identityUrl });
  rw = new Client({ connectionString: info.rwUrl });
  platform = new Client({ connectionString: info.platformUrl });
  admin = new Client({ connectionString: info.adminDbUrl });
  await Promise.all([ident.connect(), rw.connect(), platform.connect(), admin.connect()]);
});
afterAll(async () => {
  await Promise.all([ident.end(), rw.end(), platform.end(), admin.end()]);
});
beforeEach(async () => {
  await admin.query('TRUNCATE organization_members, organizations, users CASCADE');
});

const msg = (e: unknown) => String((e as Error).message);

describe('privilegios de app_identity', () => {
  it('no es superusuario ni BYPASSRLS y se conecta con su rol', async () => {
    const r = (await ident.query(`SELECT current_user u, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
    expect(r).toEqual({ u: 'app_identity', rolsuper: false, rolbypassrls: false });
  });
  it.each([
    ['DELETE en users', `DELETE FROM users`],
    ['TRUNCATE users', `TRUNCATE users`],
    ['leer contacts (negocio)', `SELECT * FROM contacts`],
    ['escribir contacts', `INSERT INTO contacts(organization_id, name) VALUES (gen_random_uuid(), 'x')`],
    ['leer platform_settings', `SELECT * FROM platform_settings`],
    ['crear tablas', `CREATE TABLE evil (id int)`],
    ['cambiarse a app_owner', `SET ROLE app_owner`],
    ['leer drizzle.__drizzle_migrations', `SELECT * FROM drizzle.__drizzle_migrations`],
  ])('app_identity NO puede %s', async (_n, q) => {
    await expect(ident.query(q)).rejects.toThrow(/permission denied|must be owner|not permitted|must have privileges/i);
  });
  it.each(['users', 'organizations', 'organization_members'])('app_rw y app_platform NO pueden leer %s', async (t) => {
    await expect(rw.query(`SELECT * FROM ${t}`)).rejects.toThrow(/permission denied/i);
    await expect(platform.query(`SELECT * FROM ${t}`)).rejects.toThrow(/permission denied/i);
    await expect(rw.query(`INSERT INTO ${t} DEFAULT VALUES`)).rejects.toThrow(/permission denied/i);
  });
});

describe('integridad de las tablas de identidad', () => {
  const org = async (kind: string, extra = '') => (await admin.query(`INSERT INTO organizations(id, kind, name, timezone ${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (gen_random_uuid(), $1, 'X', 'UTC' ${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`, [kind])).rows[0].id as string;
  const user = async (email: string, hash = HASH) => (await ident.query(`INSERT INTO users(id, email, password_hash) VALUES (gen_random_uuid(), $1, $2) RETURNING id`, [email, hash])).rows[0].id as string;

  it('email: debe estar normalizado y ser único', async () => {
    await expect(user('Ana@Example.com')).rejects.toThrow(/users_email_normalized/);
    await expect(user(' ana@example.com')).rejects.toThrow(/users_email_normalized/);
    await user('ana@example.com');
    await expect(user('ana@example.com')).rejects.toThrow(/users_email_uq/);
  });
  it('password_hash debe ser argon2id', async () => {
    await expect(user('a@b.co', 'plaintext')).rejects.toThrow(/users_password_hash_argon2id/);
    await expect(user('c@b.co', '$2b$10$abcdefghijklmnopqrstuv')).rejects.toThrow(/users_password_hash_argon2id/);
  });
  it('status solo admite valores válidos', async () => {
    await expect(ident.query(`INSERT INTO users(id,email,password_hash,status) VALUES (gen_random_uuid(),'z@z.co',$1,'otro')`, [HASH])).rejects.toThrow(/users_status_valid/);
  });
  it('organizations: kind válido, una sola organización de plataforma, hijos solo de tipo client', async () => {
    await expect(org('otro')).rejects.toThrow(/organizations_kind_valid/);
    await org('platform');
    await expect(org('platform')).rejects.toThrow(/organizations_single_platform/);
    const agency = await org('agency');
    await expect(admin.query(`INSERT INTO organizations(id,kind,name,timezone,parent_agency_id) VALUES (gen_random_uuid(),'agency','x','UTC',$1)`, [agency])).rejects.toThrow(/organizations_parent_only_client/);
    await admin.query(`INSERT INTO organizations(id,kind,name,timezone,parent_agency_id) VALUES (gen_random_uuid(),'client','x','UTC',$1)`, [agency]);
    await expect(admin.query(`INSERT INTO organizations(id,kind,name,timezone,parent_agency_id) VALUES (gen_random_uuid(),'platform','x','UTC',$1)`, [agency])).rejects.toThrow();
    await expect(admin.query(`INSERT INTO organizations(id,kind,name,timezone) VALUES (gen_random_uuid(),'client','   ','UTC')`)).rejects.toThrow(/organizations_name_not_blank/);
  });
  it('membresías: rol válido y una sola membresía ACTIVA por (usuario, organización)', async () => {
    const o = await org('agency');
    const u = await user('m@m.co');
    const ins = (role: string) => ident.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),$1,$2,$3)`, [u, o, role]);
    await expect(ins('root')).rejects.toThrow(/organization_members_role_valid/);
    await ins('agency');
    await expect(ins('advisor')).rejects.toThrow(/organization_members_active_uq/);
    await ident.query(`UPDATE organization_members SET revoked_at = now() WHERE user_id = $1`, [u]);
    await ins('advisor'); // tras revocar se puede volver a conceder
  });
  it('FK: no se puede crear una membresía hacia un usuario/organización inexistente', async () => {
    await expect(ident.query(`INSERT INTO organization_members(id,user_id,organization_id,role) VALUES (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'agency')`)).rejects.toThrow(/foreign key/i);
  });
});

describe('bootstrap del super_admin', () => {
  let pool: Pool, platformPool: Pool, rwPool: Pool, db: Database;
  const hasher = new Argon2idHasher({ memoryCost: 8192, timeCost: 1, parallelism: 1 }); // barato para tests
  beforeAll(() => {
    rwPool = new Pool({ connectionString: info.rwUrl, max: 1 });
    platformPool = new Pool({ connectionString: info.platformUrl, max: 1 });
    pool = new Pool({ connectionString: info.identityUrl, max: 6 });
    db = new Database({ app: rwPool, platform: platformPool, identity: pool }, createLogger({ level: 'silent' }));
  });
  afterAll(() => db.close());

  it('crea organización de plataforma + usuario activo + membresía super_admin; la contraseña verifica y solo se guarda el hash', async () => {
    const r = await bootstrapSuperAdmin(db, hasher, { email: '  Root@Example.COM ' });
    if (!r.created) throw new Error('debía crear');
    expect(r.email).toBe('root@example.com');
    expect(r.password.length).toBeGreaterThanOrEqual(30);
    const row = (await admin.query(`SELECT * FROM users WHERE id = $1`, [r.userId])).rows[0];
    expect(row.status).toBe('active');
    expect(row.email_verified_at).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(r.password);
    expect(await hasher.verify(row.password_hash, r.password)).toBe(true);
    const m = (await admin.query(`SELECT role, organization_id, revoked_at FROM organization_members WHERE user_id = $1`, [r.userId])).rows;
    expect(m).toEqual([{ role: 'super_admin', organization_id: r.organizationId, revoked_at: null }]);
    expect((await admin.query(`SELECT kind, timezone FROM organizations WHERE id = $1`, [r.organizationId])).rows[0]).toEqual({ kind: 'platform', timezone: 'UTC' });
  });
  it('contraseñas distintas en cada ejecución (única, no derivada del email)', async () => {
    const a = await bootstrapSuperAdmin(db, hasher, { email: 'a@x.co' });
    await admin.query('TRUNCATE organization_members, organizations, users CASCADE');
    const b = await bootstrapSuperAdmin(db, hasher, { email: 'a@x.co' });
    if (!a.created || !b.created) throw new Error('debían crear');
    expect(a.password).not.toBe(b.password);
  });
  it('es idempotente: si ya existe un super_admin no cambia nada ni devuelve contraseña', async () => {
    await bootstrapSuperAdmin(db, hasher, { email: 'root@x.co' });
    const again = await bootstrapSuperAdmin(db, hasher, { email: 'otro@x.co' });
    expect(again).toEqual({ created: false, reason: 'super_admin_exists' });
    expect((await admin.query('SELECT count(*)::int n FROM users')).rows[0].n).toBe(1);
  });
  it('ejecuciones concurrentes: exactamente una crea', async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => bootstrapSuperAdmin(db, hasher, { email: `r${i}@x.co` })));
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect((await admin.query(`SELECT count(*)::int n FROM organization_members WHERE role='super_admin'`)).rows[0].n).toBe(1);
    expect((await admin.query(`SELECT count(*)::int n FROM organizations WHERE kind='platform'`)).rows[0].n).toBe(1);
  });
  it('un super_admin REVOCADO no cuenta: se puede volver a hacer bootstrap', async () => {
    await bootstrapSuperAdmin(db, hasher, { email: 'root@x.co' });
    await admin.query('UPDATE organization_members SET revoked_at = now()');
    const r = await bootstrapSuperAdmin(db, hasher, { email: 'nuevo@x.co' });
    expect(r.created).toBe(true);
    expect((await admin.query(`SELECT count(*)::int n FROM organizations WHERE kind='platform'`)).rows[0].n).toBe(1); // reutiliza la org
  });
  it('no adopta un usuario existente que no es super_admin', async () => {
    await admin.query(`INSERT INTO users(id,email,password_hash) VALUES (gen_random_uuid(),'dup@x.co',$1)`, [HASH]);
    await expect(bootstrapSuperAdmin(db, hasher, { email: 'dup@x.co' })).rejects.toBeInstanceOf(BootstrapError);
    expect((await admin.query('SELECT count(*)::int n FROM organization_members')).rows[0].n).toBe(0);
  });
  it('rechaza emails inválidos', async () => {
    for (const e of ['', 'sin-arroba', 'a@b', 'a b@c.co']) await expect(bootstrapSuperAdmin(db, hasher, { email: e })).rejects.toBeInstanceOf(BootstrapError);
  });
  it('es atómico: si falla a mitad no queda nada creado', async () => {
    await expect(bootstrapSuperAdmin(db, { hash: () => Promise.resolve('no-argon'), verify: () => Promise.resolve(false), needsRehash: () => false }, { email: 'x@x.co' })).rejects.toBeTruthy();
    for (const t of ['users', 'organizations', 'organization_members']) expect((await admin.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n).toBe(0);
  });
  it('withIdentity vía Drizzle lee con el rol correcto', async () => {
    await bootstrapSuperAdmin(db, hasher, { email: 'r@x.co' });
    const rows = await db.withIdentity((tx) => tx.select({ e: users.email }).from(users).where(eq(users.email, 'r@x.co')));
    expect(rows).toEqual([{ e: 'r@x.co' }]);
    expect(organizations).toBeDefined();
    expect(organizationMembers).toBeDefined();
  });
  it('withIdentity no puede consultar tablas de negocio aunque el código lo intente', async () => {
    const e = await rejection(db.withIdentity((tx) => tx.execute('SELECT * FROM contacts' as never)));
    expect(msg(e)).toMatch(/permission denied/i);
  });
});
