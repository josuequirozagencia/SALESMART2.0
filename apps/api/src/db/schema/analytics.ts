import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Ajustes de analítica de la empresa (M6.5, ADR-51). Una fila por empresa, que se crea al primer cambio; sin fila rige el valor por omisión (el asesor SÍ puede descargar).
 * Sin DELETE: se cambia el interruptor.
 */
export const analyticsSettings = tenantTable(
  'analytics_settings',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    /** ¿Puede el asesor descargar reportes en CSV? (el administrador siempre puede). */
    advisorExport: boolean('advisor_export').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('analytics_settings_org_uq').on(t['organizationId']!)],
);

/**
 * Registro de CADA descarga de un reporte en CSV: quién, cuándo, qué reporte, qué periodo y cuántas filas. Solo de inserción (sin UPDATE ni DELETE): es el rastro que ve el administrador
 * en «Descargas». No guarda los datos descargados.
 */
export const analyticsExports = tenantTable(
  'analytics_exports',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    userId: uuid('user_id').notNull().references(() => users.id),
    report: text('report').notNull(),
    fromAt: ts('from_at').notNull(),
    toAt: ts('to_at').notNull(),
    rowCount: integer('row_count').notNull(),
    /** Con qué alcance se generó: `all` (toda la empresa) o `own` (solo lo de la persona). */
    scope: text('scope').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('analytics_exports_report_valid', sql`${t['report']!} IN ('sales', 'appointments', 'funnel', 'advisors')`),
    check('analytics_exports_scope_valid', sql`${t['scope']!} IN ('all', 'own')`),
    check('analytics_exports_count_valid', sql`${t['rowCount']!} >= 0`),
    check('analytics_exports_period_valid', sql`${t['toAt']!} > ${t['fromAt']!}`),
    index('analytics_exports_recent_idx').on(t['organizationId']!, t['createdAt']!, t['id']!),
  ],
);
