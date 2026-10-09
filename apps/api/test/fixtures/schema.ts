// Esquema de FIXTURES de test (no es esquema de producción). Usa los helpers reales de producción para que
// los tests validen que tenantTable()/platformTable() generan RLS correcto en PostgreSQL real.
import { foreignKey, integer, numeric, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { platformTable, tenantTable } from '../../src/db/schema/helpers';

export const contacts = tenantTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
});

export const deals = tenantTable(
  'deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'deals_contact_fk',
      columns: [t['organizationId']!, t['contactId']!],
      foreignColumns: [contacts.organizationId, contacts.id],
    }),
  ],
);

export const counters = tenantTable(
  'counters',
  { key: text('key').notNull(), value: integer('value').notNull().default(0) },
  (t) => [primaryKey({ columns: [t['organizationId']!, t['key']!] })],
);

export const platformSettings = platformTable('platform_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const TENANT_FIXTURES = [contacts, deals, counters] as const;
export const PLATFORM_FIXTURES = [platformSettings] as const;
export const FIXTURE_CATALOG = {
  platform: ['platform_settings', 'platform_audit'],
  identity: ['users', 'organizations', 'organization_members', 'sessions', 'auth_throttle', 'email_verifications', 'signup_attempts', 'disposable_domains', 'password_resets', 'roles', 'permissions', 'role_permissions', 'trials', 'trial_config'],
  reference: [],
  tenantRoot: [],
  securityDefiner: [],
} as const;
