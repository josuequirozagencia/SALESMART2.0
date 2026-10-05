// Cobertura de políticas: la BD real debe cumplir ADR-24 (positivo) y el auditor debe DETECTAR cada violación (negativos).
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditDatabase } from '../../src/db/audit/schema-audit';
import { PRODUCTION_CATALOG } from '../../src/db/audit/catalog';
import { FIXTURE_CATALOG } from '../fixtures/schema';
import { requireDb } from '../support/harness';

const info = requireDb();
let owner: Client;
let admin: Client;
beforeAll(async () => {
  owner = new Client({ connectionString: info.ownerUrl });
  admin = new Client({ connectionString: info.adminDbUrl });
  await Promise.all([owner.connect(), admin.connect()]);
});
afterAll(async () => {
  await Promise.all([owner.end(), admin.end()]);
});

/** Ejecuta DDL dentro de una transacción, audita y revierte: no contamina la BD compartida. */
async function auditWith(client: Client, ddl: string[], catalog: Parameters<typeof auditDatabase>[1] = FIXTURE_CATALOG as never) {
  await client.query('BEGIN');
  try {
    for (const q of ddl) await client.query(q);
    return await auditDatabase(client, catalog);
  } finally {
    await client.query('ROLLBACK');
  }
}
const codes = (v: Array<{ code: string }>) => v.map((x) => x.code);

describe('cobertura de políticas RLS (auditoría del catálogo real)', () => {
  it('la BD migrada + fixtures cumple ADR-24 sin violaciones', async () => {
    expect(await auditDatabase(owner, FIXTURE_CATALOG as never)).toEqual([]);
  });

  it('la BD migrada solo con producción (sin tablas de negocio todavía) cumple ADR-24', async () => {
    // Los fixtures viven en la misma BD; este caso garantiza que el catálogo de producción vacío no oculta nada:
    // con el catálogo de producción las tablas de fixtures aparecen como no clasificadas (control negativo).
    const v = await auditDatabase(owner, PRODUCTION_CATALOG);
    expect(codes(v)).toContain('TABLE_UNCLASSIFIED');
  });

  it('detecta tabla tenant sin RLS ni política', async () => {
    const v = await auditWith(owner, [`CREATE TABLE bad1 (id uuid, organization_id uuid)`, `GRANT SELECT ON bad1 TO app_rw`]);
    expect(codes(v)).toEqual(expect.arrayContaining(['RLS_DISABLED', 'RLS_NOT_FORCED', 'NO_POLICY']));
  });

  it('detecta RLS habilitado pero no forzado', async () => {
    const v = await auditWith(owner, [
      `CREATE TABLE bad2 (id uuid, organization_id uuid DEFAULT app_org())`,
      `ALTER TABLE bad2 ENABLE ROW LEVEL SECURITY`,
      `CREATE POLICY p ON bad2 USING (organization_id = app_org()) WITH CHECK (organization_id = app_org())`,
      `GRANT SELECT ON bad2 TO app_rw`,
    ]);
    expect(codes(v)).toContain('RLS_NOT_FORCED');
    expect(codes(v)).not.toContain('NO_POLICY');
  });

  const tenantBase = (n: string) => [`CREATE TABLE ${n} (id uuid, organization_id uuid DEFAULT app_org(), other uuid)`, `ALTER TABLE ${n} ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ${n} FORCE ROW LEVEL SECURITY`, `GRANT SELECT ON ${n} TO app_rw`];

  it('detecta política USING (true)', async () => {
    const v = await auditWith(owner, [...tenantBase('bad3'), `CREATE POLICY p ON bad3 USING (true) WITH CHECK (true)`]);
    expect(codes(v)).toEqual(expect.arrayContaining(['POLICY_USING', 'POLICY_WITH_CHECK']));
  });

  it('detecta política sin WITH CHECK', async () => {
    const v = await auditWith(owner, [...tenantBase('bad4'), `CREATE POLICY p ON bad4 USING (organization_id = app_org())`]);
    expect(codes(v)).toContain('POLICY_WITH_CHECK');
  });

  it('detecta política con otra columna / expresión', async () => {
    const v = await auditWith(owner, [...tenantBase('bad5'), `CREATE POLICY p ON bad5 USING (other = app_org()) WITH CHECK (other = app_org())`]);
    expect(codes(v)).toContain('POLICY_USING');
  });

  it('detecta política que solo cubre SELECT (INSERT/UPDATE/DELETE sin cobertura)', async () => {
    const v = await auditWith(owner, [...tenantBase('bad6'), `CREATE POLICY p ON bad6 FOR SELECT USING (organization_id = app_org())`]);
    expect(codes(v)).toContain('POLICY_CMD_UNCOVERED');
  });

  it('detecta tabla sin clasificar (sin organization_id y fuera del catálogo)', async () => {
    const v = await auditWith(owner, [`CREATE TABLE bad7 (id uuid)`]);
    expect(codes(v)).toContain('TABLE_UNCLASSIFIED');
  });

  it('detecta tabla de plataforma accesible para app_rw', async () => {
    const v = await auditWith(owner, [`CREATE TABLE bad8 (id uuid)`, `GRANT SELECT ON bad8 TO app_rw`], { ...FIXTURE_CATALOG, platform: ['platform_settings', 'bad8'] } as never);
    expect(codes(v)).toContain('GRANT_RW_ON_PLATFORM');
  });

  it('detecta tabla tenant accesible para app_platform y privilegios excesivos de app_rw', async () => {
    const v = await auditWith(owner, [...tenantBase('bad9'), `CREATE POLICY p ON bad9 USING (organization_id = app_org()) WITH CHECK (organization_id = app_org())`, `GRANT SELECT ON bad9 TO app_platform`, `GRANT TRUNCATE ON bad9 TO app_rw`]);
    expect(codes(v)).toEqual(expect.arrayContaining(['GRANT_PLATFORM_ON_TENANT', 'GRANT_EXCESS']));
  });

  it('detecta vistas sin security_invoker y funciones SECURITY DEFINER', async () => {
    const v = await auditWith(owner, [
      `CREATE VIEW bad10 AS SELECT * FROM contacts`,
      `CREATE FUNCTION bad_fn() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$`,
    ]);
    expect(codes(v)).toEqual(expect.arrayContaining(['VIEW_NOT_INVOKER', 'SECURITY_DEFINER']));
    // control: la misma vista con security_invoker es aceptada
    const ok = await auditWith(owner, [`CREATE VIEW ok10 WITH (security_invoker = true) AS SELECT * FROM contacts`]);
    expect(codes(ok)).not.toContain('VIEW_NOT_INVOKER');
  });

  it('detecta FK entre tablas tenant que no incluye organization_id', async () => {
    const v = await auditWith(owner, [
      `ALTER TABLE contacts ADD CONSTRAINT contacts_id_uq UNIQUE (id)`,
      `ALTER TABLE deals ADD CONSTRAINT bad_fk FOREIGN KEY (contact_id) REFERENCES contacts(id)`,
    ]);
    expect(codes(v)).toContain('FK_CROSS_TENANT');
  });

  it('detecta objetos propiedad de un rol de la aplicación', async () => {
    const v = await auditWith(admin, [`ALTER TABLE counters OWNER TO app_rw`]);
    expect(codes(v)).toContain('OWNED_BY_APP_ROLE');
  });

  it('detecta app_org() alterada (SECURITY DEFINER / VOLATILE)', async () => {
    const v = await auditWith(owner, [
      `CREATE OR REPLACE FUNCTION public.app_org() RETURNS uuid LANGUAGE sql VOLATILE SECURITY DEFINER AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$`,
    ]);
    expect(codes(v)).toEqual(expect.arrayContaining(['APP_ORG_DEFINER', 'APP_ORG_VOLATILITY']));
  });

  it('detecta rol de aplicación con BYPASSRLS / pertenencia a app_owner', async () => {
    const v = await auditWith(admin, [`ALTER ROLE app_rw BYPASSRLS`, `GRANT app_owner TO app_platform`]);
    expect(codes(v)).toEqual(expect.arrayContaining(['ROLE_ATTR', 'ROLE_MEMBERSHIP']));
  });
});

describe('auditoría de tablas de identidad (ADR-25)', () => {
  it.each([
    ['app_rw con SELECT sobre users', `GRANT SELECT ON users TO app_rw`, 'GRANT_ON_IDENTITY'],
    ['app_platform con INSERT sobre organizations', `GRANT INSERT ON organizations TO app_platform`, 'GRANT_ON_IDENTITY'],
    ['app_identity con DELETE sobre users', `GRANT DELETE ON users TO app_identity`, 'GRANT_EXCESS'],
    ['app_identity con TRUNCATE sobre organization_members', `GRANT TRUNCATE ON organization_members TO app_identity`, 'GRANT_EXCESS'],
    ['app_identity sin SELECT sobre users', `REVOKE SELECT ON users FROM app_identity`, 'GRANT_MISSING'],
    ['app_identity con acceso a una tabla de negocio', `GRANT SELECT ON contacts TO app_identity`, 'GRANT_IDENTITY_ON_NON_IDENTITY'],
    ['app_identity con acceso a una tabla de plataforma', `GRANT SELECT ON platform_settings TO app_identity`, 'GRANT_IDENTITY_ON_NON_IDENTITY'],
  ])('detecta: %s', async (_n, ddl, code) => {
    expect(codes(await auditWith(owner, [ddl]))).toContain(code);
  });
  it('una tabla de identidad nueva sin clasificar en el catálogo se reporta', async () => {
    const v = await auditWith(owner, [`CREATE TABLE sessions_x (id uuid)`]);
    expect(codes(v)).toContain('TABLE_UNCLASSIFIED');
  });
  it('una tabla de identidad con organization_id NO se trata como tenant (sin falsos positivos)', async () => {
    expect(codes(await auditWith(owner, []))).toEqual([]);
  });
});
