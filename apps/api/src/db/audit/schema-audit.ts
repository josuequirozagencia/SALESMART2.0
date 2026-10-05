import { APP_CONNECTION_ROLES, DB_ROLES, FORBIDDEN_ROLE_ATTRS } from '../roles';
import type { TableCatalog } from './catalog';

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}
export interface Violation {
  code: string;
  object: string;
  message: string;
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/[\s()]/g, '').toLowerCase();

/**
 * Auditoría del catálogo real de PostgreSQL contra las reglas de ADR-24. Solo lectura.
 * Devuelve la lista de violaciones (vacía = conforme).
 */
export async function auditDatabase(db: Queryable, catalog: TableCatalog): Promise<Violation[]> {
  const v: Violation[] = [];
  const add = (code: string, object: string, message: string) => v.push({ code, object, message });

  // ── Roles ───────────────────────────────────────────────────────────────────────────────────────
  const roles = (
    await db.query<Record<string, unknown>>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
         FROM pg_roles WHERE rolname = ANY($1)`,
      [[DB_ROLES.owner, ...APP_CONNECTION_ROLES]],
    )
  ).rows;
  for (const name of [DB_ROLES.owner, ...APP_CONNECTION_ROLES]) {
    if (!roles.some((r) => r['rolname'] === name)) add('ROLE_MISSING', name, `el rol ${name} no existe`);
  }
  for (const r of roles) {
    if (r['rolname'] === DB_ROLES.owner) {
      if (r['rolsuper'] || r['rolbypassrls']) add('ROLE_OWNER_PRIVILEGED', String(r['rolname']), 'el dueño no debe ser superusuario ni BYPASSRLS');
      continue;
    }
    for (const a of FORBIDDEN_ROLE_ATTRS) {
      if (r[a]) add('ROLE_ATTR', String(r['rolname']), `el rol de aplicación tiene ${a}=true`);
    }
  }
  const members = (
    await db.query<{ member: string; role: string }>(
      `SELECT m.rolname AS member, g.rolname AS role FROM pg_auth_members am
         JOIN pg_roles m ON m.oid = am.member JOIN pg_roles g ON g.oid = am.roleid
        WHERE m.rolname = ANY($1)`,
      [APP_CONNECTION_ROLES],
    )
  ).rows;
  for (const m of members) add('ROLE_MEMBERSHIP', m.member, `${m.member} es miembro de ${m.role} (herencia de privilegios)`);

  const owned = (
    await db.query<{ owner: string; name: string }>(
      `SELECT r.rolname AS owner, c.relname AS name FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S') AND r.rolname = ANY($1)`,
      [APP_CONNECTION_ROLES],
    )
  ).rows;
  for (const o of owned) add('OWNED_BY_APP_ROLE', o.name, `el objeto pertenece a ${o.owner}; el dueño debe ser ${DB_ROLES.owner}`);

  // ── app_org() ───────────────────────────────────────────────────────────────────────────────────
  const fn = (
    await db.query<{ prosecdef: boolean; provolatile: string; src: string }>(
      `SELECT p.prosecdef, p.provolatile, p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'app_org' AND p.pronargs = 0`,
    )
  ).rows[0];
  if (!fn) add('APP_ORG_MISSING', 'app_org()', 'falta la función app_org()');
  else {
    if (fn.prosecdef) add('APP_ORG_DEFINER', 'app_org()', 'app_org() no puede ser SECURITY DEFINER');
    if (fn.provolatile !== 's') add('APP_ORG_VOLATILITY', 'app_org()', 'app_org() debe ser STABLE');
    if (!/current_setting\(\s*'app\.org_id'\s*,\s*true\s*\)/i.test(fn.src)) add('APP_ORG_BODY', 'app_org()', "app_org() debe leer current_setting('app.org_id', true)");
  }

  // ── Funciones SECURITY DEFINER ──────────────────────────────────────────────────────────────────
  const definers = (
    await db.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef`,
    )
  ).rows;
  for (const d of definers) {
    if (!catalog.securityDefiner.includes(d.proname)) add('SECURITY_DEFINER', d.proname, 'función SECURITY DEFINER no aprobada (requiere ADR y alta en el catálogo)');
  }

  // ── Vistas (eluden RLS salvo security_invoker) ──────────────────────────────────────────────────
  const views = (
    await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('v','m')`,
    )
  ).rows;
  for (const w of views) {
    if (!(w.reloptions ?? []).some((o) => /^security_invoker=(true|on)$/i.test(o))) {
      add('VIEW_NOT_INVOKER', w.relname, 'vista/materializada sin security_invoker=true (puede eludir RLS)');
    }
  }

  // ── Tablas ──────────────────────────────────────────────────────────────────────────────────────
  const tables = (
    await db.query<{ relname: string; rls: boolean; force: boolean; has_org: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped) AS has_org
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1`,
    )
  ).rows;
  const policies = (
    await db.query<{ tablename: string; policyname: string; permissive: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }>(
      `SELECT tablename, policyname, permissive, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname = 'public'`,
    )
  ).rows;
  const priv = async (role: string, table: string, p: string) =>
    (await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS ok`, [role, table, p])).rows[0]?.ok === true;

  const kindOf = new Map<string, 'tenant' | 'tenantRoot' | 'platform' | 'reference' | 'identity'>();
  const anyPriv = async (role: string, table: string) => {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      if (await priv(role, table, p)) return p;
    }
    return null;
  };
  for (const t of tables) {
    // Identidad (ADR-25): fuera de RLS; solo app_identity (SELECT/INSERT/UPDATE). Se evalúa antes que el resto.
    if (catalog.identity.includes(t.relname)) {
      if (catalog.platform.includes(t.relname) || catalog.reference.includes(t.relname) || catalog.tenantRoot.includes(t.relname)) {
        add('TABLE_MULTI_CLASS', t.relname, 'tabla clasificada en más de una categoría del catálogo');
      }
      kindOf.set(t.relname, 'identity');
      if (!(await priv(DB_ROLES.identity, t.relname, 'SELECT'))) add('GRANT_MISSING', t.relname, 'app_identity sin SELECT');
      for (const bad of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        if (await priv(DB_ROLES.identity, t.relname, bad)) add('GRANT_EXCESS', t.relname, `app_identity tiene ${bad}`);
      }
      for (const role of [DB_ROLES.rw, DB_ROLES.platform]) {
        const p = await anyPriv(role, t.relname);
        if (p) add('GRANT_ON_IDENTITY', t.relname, `${role} no debe tener privilegios sobre tablas de identidad (tiene ${p})`);
      }
      continue;
    }
    const inPlatform = catalog.platform.includes(t.relname);
    const inRef = catalog.reference.includes(t.relname);
    const inRoot = catalog.tenantRoot.includes(t.relname);
    const classes = [inPlatform, inRef, inRoot].filter(Boolean).length;
    if (classes > 1) add('TABLE_MULTI_CLASS', t.relname, 'tabla clasificada en más de una categoría del catálogo');
    if (t.has_org && classes > 0) add('TABLE_ORG_COLUMN_MISCLASSIFIED', t.relname, 'tiene organization_id pero está clasificada como no-tenant');
    kindOf.set(t.relname, inPlatform ? 'platform' : inRef ? 'reference' : inRoot ? 'tenantRoot' : t.has_org ? 'tenant' : 'platform');
    if (!t.has_org && classes === 0) {
      add('TABLE_UNCLASSIFIED', t.relname, 'sin organization_id y sin clasificar en db/audit/catalog.ts');
      continue;
    }
    const kind = kindOf.get(t.relname)!;
    {
      const p = await anyPriv(DB_ROLES.identity, t.relname);
      if (p) add('GRANT_IDENTITY_ON_NON_IDENTITY', t.relname, `app_identity solo puede acceder a tablas de identidad (tiene ${p})`);
    }

    if (kind === 'tenant' || kind === 'tenantRoot') {
      const key = kind === 'tenant' ? 'organization_id' : 'id';
      if (!t.rls) add('RLS_DISABLED', t.relname, 'RLS no habilitado');
      if (!t.force) add('RLS_NOT_FORCED', t.relname, 'FORCE ROW LEVEL SECURITY no activo');
      const pols = policies.filter((p) => p.tablename === t.relname);
      if (pols.length === 0) add('NO_POLICY', t.relname, 'sin políticas');
      for (const p of pols) {
        const expected = norm(`${key} = app_org()`);
        if (p.permissive !== 'PERMISSIVE') add('POLICY_RESTRICTIVE', `${t.relname}.${p.policyname}`, 'solo se admiten políticas PERMISSIVE de aislamiento (revisar si es intencionado)');
        if (norm(p.qual) !== expected) add('POLICY_USING', `${t.relname}.${p.policyname}`, `USING debe ser (${key} = app_org()); encontrado: ${p.qual ?? 'NULL'}`);
        if (p.cmd !== 'DELETE' && p.cmd !== 'SELECT' && norm(p.with_check) !== expected) {
          add('POLICY_WITH_CHECK', `${t.relname}.${p.policyname}`, `WITH CHECK debe ser (${key} = app_org()); encontrado: ${p.with_check ?? 'NULL'}`);
        }
      }
      // cobertura por comando: debe existir al menos una política que cubra cada comando
      for (const cmd of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        if (!pols.some((p) => p.cmd === 'ALL' || p.cmd === cmd)) add('POLICY_CMD_UNCOVERED', t.relname, `ninguna política cubre ${cmd}`);
      }
      if (!(await priv(DB_ROLES.rw, t.relname, 'SELECT'))) add('GRANT_MISSING', t.relname, 'app_rw sin SELECT');
      if (await priv(DB_ROLES.platform, t.relname, 'SELECT')) add('GRANT_PLATFORM_ON_TENANT', t.relname, 'app_platform no debe acceder a tablas tenant');
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        if (await priv(DB_ROLES.rw, t.relname, bad)) add('GRANT_EXCESS', t.relname, `app_rw tiene ${bad}`);
      }
    } else if (kind === 'platform') {
      if (await priv(DB_ROLES.rw, t.relname, 'SELECT') || (await priv(DB_ROLES.rw, t.relname, 'INSERT'))) add('GRANT_RW_ON_PLATFORM', t.relname, 'app_rw no debe acceder a tablas de plataforma');
      for (const bad of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        if (await priv(DB_ROLES.platform, t.relname, bad)) add('GRANT_EXCESS', t.relname, `app_platform tiene ${bad}`);
      }
    } else if (kind === 'reference') {
      for (const bad of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        if (await priv(DB_ROLES.rw, t.relname, bad)) add('GRANT_REFERENCE_WRITE', t.relname, `app_rw no debe tener ${bad} sobre tablas de referencia`);
      }
    }
  }

  // ── FKs entre tablas tenant: deben incluir organization_id en ambos lados ───────────────────────
  const fks = (
    await db.query<{ conname: string; child: string; parent: string; child_cols: string[]; parent_cols: string[] }>(
      `SELECT con.conname, cc.relname AS child, pc.relname AS parent,
              ARRAY(SELECT a.attname FROM unnest(con.conkey) k JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k) AS child_cols,
              ARRAY(SELECT a.attname FROM unnest(con.confkey) k JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k) AS parent_cols
         FROM pg_constraint con JOIN pg_class cc ON cc.oid = con.conrelid JOIN pg_class pc ON pc.oid = con.confrelid
         JOIN pg_namespace n ON n.oid = cc.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'public'`,
    )
  ).rows;
  for (const f of fks) {
    if (kindOf.get(f.child) === 'tenant' && kindOf.get(f.parent) === 'tenant') {
      if (!f.child_cols.includes('organization_id') || !f.parent_cols.includes('organization_id')) {
        add('FK_CROSS_TENANT', `${f.child}.${f.conname}`, 'FK entre tablas tenant debe ser compuesta con organization_id (si no, permite referenciar filas de otra organización)');
      }
    }
  }

  return v;
}
