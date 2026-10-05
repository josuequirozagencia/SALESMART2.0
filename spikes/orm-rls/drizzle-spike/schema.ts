// DESCARTABLE — esquema Drizzle con RLS declarativa
import { pgTable, uuid, text, numeric, integer, primaryKey, pgPolicy } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
const tenant = (col: string) => ({ using: sql.raw(`${col} = app_org()`), withCheck: sql.raw(`${col} = app_org()`) });
export const organizations = pgTable('organizations', { id: uuid().primaryKey(), name: text().notNull() },
  () => [pgPolicy('tenant_isolation', tenant('id'))]).enableRLS();
export const contacts = pgTable('contacts', {
  id: uuid().primaryKey().defaultRandom(), organizationId: uuid('organization_id').notNull(), name: text().notNull(),
}, () => [pgPolicy('tenant_isolation', tenant('organization_id'))]).enableRLS();
export const deals = pgTable('deals', {
  id: uuid().primaryKey().defaultRandom(), organizationId: uuid('organization_id').notNull(),
  contactId: uuid('contact_id').notNull(), amount: numeric({ precision: 14, scale: 2 }).notNull(),
}, () => [pgPolicy('tenant_isolation', tenant('organization_id'))]).enableRLS();
export const counters = pgTable('counters', {
  organizationId: uuid('organization_id').notNull(), key: text().notNull(), value: integer().notNull().default(0),
}, (t) => [primaryKey({ columns: [t.organizationId, t.key] }), pgPolicy('tenant_isolation', tenant('organization_id'))]).enableRLS();
export const aiPricing = pgTable('ai_pricing', { id: integer().primaryKey(), costPerCredit: numeric('cost_per_credit', { precision: 10, scale: 4 }).notNull() });
