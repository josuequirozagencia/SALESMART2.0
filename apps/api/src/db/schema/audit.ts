import { sql } from 'drizzle-orm';
import { check, index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { platformTable, tenantTable } from './helpers';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Auditoría del CLIENTE (Build Spec §6.10). Tabla tenant (RLS) y APPEND-ONLY: la migración concede solo SELECT e INSERT a
 * app_rw (sin UPDATE/DELETE/TRUNCATE). `acting_as`/`acting_org_id` marcan al Súper Admin o agencia que actúa dentro del cliente.
 * Los valores antiguo/nuevo se guardan como jsonb; los campos sensibles (contraseñas, tokens…) se registran SIN valor.
 */
export const auditLogs = tenantTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    field: text('field'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    /** null = acción del sistema (sin usuario). */
    actorUserId: uuid('actor_user_id'),
    actingAs: text('acting_as'),
    actingOrgId: uuid('acting_org_id'),
    source: text('source').notNull(),
    requestId: text('request_id'),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [
    check('audit_logs_source_valid', sql`${t['source']} IN ('manual', 'ai', 'automation', 'ghl', 'meta', 'api')`),
    check('audit_logs_acting_as_valid', sql`${t['actingAs']} IS NULL OR ${t['actingAs']} IN ('super_admin', 'agency')`),
    check('audit_logs_entity_type_shape', sql`${t['entityType']} ~ '^[a-z][a-z0-9_.]{0,63}$'`),
    index('audit_logs_entity_idx').on(t['organizationId']!, t['entityType']!, t['entityId']!, t['at']!),
  ],
);

/**
 * Auditoría de PLATAFORMA (acciones del Súper Admin sin organización activa). Tabla de plataforma (rol app_platform),
 * append-only: solo SELECT e INSERT.
 */
export const platformAudit = platformTable('platform_audit', {
  id: uuid('id').primaryKey().$defaultFn(uuidv7),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  actorUserId: uuid('actor_user_id').notNull(),
  targetOrgId: uuid('target_org_id'),
  details: jsonb('details'),
  requestId: text('request_id'),
  at: ts('at').notNull().defaultNow(),
});
