// Privilegios reales de los roles de PostgreSQL (ADR-24): lo que la app NO puede hacer aunque su código sea malicioso.
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORG_A } from '../support/constants';
import { requireDb } from '../support/harness';

const info = requireDb();
let rw: Client;
let platform: Client;
beforeAll(async () => {
  rw = new Client({ connectionString: info.rwUrl });
  platform = new Client({ connectionString: info.platformUrl });
  await Promise.all([rw.connect(), platform.connect()]);
});
afterAll(async () => {
  await Promise.all([rw.end(), platform.end()]);
});

describe('app_rw (conexión de la aplicación)', () => {
  it('no es superusuario, no tiene BYPASSRLS ni CREATEROLE/CREATEDB/REPLICATION', async () => {
    const r = (await rw.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = current_user`)).rows[0];
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
    expect((await rw.query(`SELECT current_user AS u`)).rows[0].u).toBe('app_rw');
  });

  it.each([
    ['crear tablas', `CREATE TABLE evil (id int)`],
    ['deshabilitar RLS', `ALTER TABLE contacts DISABLE ROW LEVEL SECURITY`],
    ['quitar FORCE RLS', `ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY`],
    ['borrar la política', `DROP POLICY contacts_tenant_isolation ON contacts`],
    ['crear políticas', `CREATE POLICY evil ON contacts USING (true)`],
    ['TRUNCATE', `TRUNCATE contacts`],
    ['cambiarse a app_owner', `SET ROLE app_owner`],
    ['saltar triggers/FK con session_replication_role', `SET session_replication_role = replica`],
    ['alterarse a sí mismo BYPASSRLS', `ALTER ROLE app_rw BYPASSRLS`],
    ['leer el esquema de migraciones', `SELECT * FROM drizzle.__drizzle_migrations`],
    ['redefinir app_org()', `CREATE OR REPLACE FUNCTION public.app_org() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$`],
    ['leer tablas de plataforma', `SELECT * FROM platform_settings`],
    ['COPY a programa', `COPY contacts TO PROGRAM 'id'`],
  ])('app_rw NO puede %s', async (_n, q) => {
    await expect(rw.query(q)).rejects.toThrow(/permission denied|must be owner|must be superuser|no such|only superuser|not permitted|must have privileges/i);
  });

  it('sin contexto no ve ni escribe datos de negocio (falla cerrado)', async () => {
    expect((await rw.query('SELECT * FROM contacts')).rowCount).toBe(0);
    await expect(rw.query(`UPDATE contacts SET name = 'x'`)).resolves.toMatchObject({ rowCount: 0 });
    await expect(rw.query(`INSERT INTO contacts(organization_id, name) VALUES ('${ORG_A}', 'x')`)).rejects.toThrow(/row-level security/);
  });

  it('un valor de contexto mal formado falla en lugar de abrir acceso', async () => {
    await rw.query('BEGIN');
    try {
      await rw.query(`SELECT set_config('app.org_id', 'no-es-uuid', true)`);
      await expect(rw.query('SELECT * FROM contacts')).rejects.toThrow(/invalid input syntax for type uuid/);
    } finally {
      await rw.query('ROLLBACK');
    }
  });
});

describe('app_platform (operaciones de plataforma)', () => {
  it('no es superusuario ni BYPASSRLS', async () => {
    const r = (await platform.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it('accede a tablas de plataforma', async () => {
    await expect(platform.query('SELECT * FROM platform_settings')).resolves.toBeDefined();
  });
  it.each(['contacts', 'deals', 'counters'])('NO accede a la tabla de negocio %s', async (t) => {
    await expect(platform.query(`SELECT * FROM ${t}`)).rejects.toThrow(/permission denied/);
  });
  it('no puede ejecutar app_org() (solo app_rw/owner)', async () => {
    await expect(platform.query('SELECT app_org()')).rejects.toThrow(/permission denied/);
  });
});

describe('PUBLIC', () => {
  it('no hay privilegios por defecto para PUBLIC en el esquema public', async () => {
    const admin = new Client({ connectionString: info.adminDbUrl });
    await admin.connect();
    try {
      const r = await admin.query(`SELECT has_schema_privilege('public', 'public', 'CREATE') AS c, has_schema_privilege('public', 'public', 'USAGE') AS u`);
      expect(r.rows[0]).toEqual({ c: false, u: false });
    } finally {
      await admin.end();
    }
  });
});
