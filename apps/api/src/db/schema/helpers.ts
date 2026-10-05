import { sql } from 'drizzle-orm';
import { pgPolicy, pgTable, unique, uuid, type AnyPgColumn, type PgColumnBuilderBase } from 'drizzle-orm/pg-core';

/**
 * Tabla de negocio multi-tenant (ADR-24). Es la ÚNICA forma permitida de declarar tablas de negocio:
 *  - `organization_id uuid NOT NULL DEFAULT app_org()` (el código no pasa la organización al insertar);
 *  - política RLS `USING` + `WITH CHECK` (organization_id = app_org());
 *  - ENABLE RLS. FORCE RLS y los GRANT van en la migración (drizzle-kit no los genera) y los verifica
 *    `pnpm db:audit` + los tests de cobertura de políticas.
 *  - si la tabla tiene columna `id`, añade UNIQUE (organization_id, id) para poder declarar FKs compuestas
 *    (organization_id, x_id) → (organization_id, id): impiden referencias entre organizaciones.
 */
export function tenantTable<TCols extends Record<string, PgColumnBuilderBase>>(
  name: string,
  columns: TCols,
  extra?: (t: Record<string, AnyPgColumn>) => unknown[],
) {
  const organizationId = uuid('organization_id').notNull().default(sql`app_org()`);
  return pgTable(
    name,
    { organizationId, ...columns },
    (t) => {
      const cols = t as unknown as Record<string, AnyPgColumn>;
      return [
        pgPolicy(`${name}_tenant_isolation`, {
          as: 'permissive',
          for: 'all',
          using: sql`organization_id = app_org()`,
          withCheck: sql`organization_id = app_org()`,
        }),
        ...('id' in columns && cols['organizationId'] && cols['id']
          ? [unique(`${name}_org_id_uq`).on(cols['organizationId'], cols['id'])]
          : []),
        ...((extra?.(cols) ?? []) as never[]),
      ];
    },
  ).enableRLS();
}

/**
 * Tabla de IDENTIDAD (ADR-25): sin organization_id ni RLS; solo accesible por el rol app_identity vía GRANT.
 * Debe registrarse en IDENTITY (db/audit/catalog.ts); sin eso `db:audit` falla.
 */
export function identityTable<TCols extends Record<string, PgColumnBuilderBase>>(
  name: string,
  columns: TCols,
  extra?: (t: { [K in keyof TCols]: AnyPgColumn }) => unknown[],
) {
  return pgTable(name, columns, extra as never);
}

/**
 * Tabla de plataforma (sin organization_id; solo accesible por el rol app_platform vía GRANT).
 * Debe registrarse en PLATFORM_TABLES (db/audit/catalog.ts); sin eso `db:audit` falla.
 */
export function platformTable<TCols extends Record<string, PgColumnBuilderBase>>(name: string, columns: TCols) {
  return pgTable(name, columns);
}
