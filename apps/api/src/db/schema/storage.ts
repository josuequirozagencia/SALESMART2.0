import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, numeric, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { platformTable, tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Catálogo de planes de espacio extra de la biblioteca (V21b, ADR-75). TABLA DE PLATAFORMA: solo `app_platform` la lee y la escribe; la API de cliente expone solo el precio de lista de los planes activos.
 * Sin DELETE: un plan se desactiva (`active = false`). Lo ya vendido no cambia al editarlo, porque cada concesión guarda su propia copia (`storage_grants`).
 */
export const storagePlans = platformTable(
  'storage_plans',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    extraBytes: bigint('extra_bytes', { mode: 'number' }).notNull(),
    priceAmount: numeric('price_amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('USD'),
    period: text('period').notNull().default('monthly'),
    active: boolean('active').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('storage_plans_name_len', sql`length(btrim(${t.name})) BETWEEN 1 AND 80`),
    check('storage_plans_bytes_valid', sql`${t.extraBytes} BETWEEN 1 AND 10995116277760`),
    check('storage_plans_price_valid', sql`${t.priceAmount} >= 0 AND ${t.priceAmount} <= 1000000`),
    check('storage_plans_currency_valid', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('storage_plans_period_valid', sql`${t.period} IN ('monthly')`),
  ],
);

/**
 * Espacio extra concedido a una empresa (V21b). TABLA DE NEGOCIO (RLS forzada) de SOLO INSERCIÓN: ni UPDATE ni DELETE. Anular una concesión es insertar una fila `kind = 'revoke'` enlazada con
 * `revokes_grant_id` (una sola por concesión). El cupo efectivo se DERIVA: cupo incluido + suma de `extra_bytes` de las concesiones vigentes ahora (`starts_at <= now < ends_at`) y no anuladas.
 * Cada concesión guarda una COPIA del nombre, los bytes y el precio del plan al venderlo. `origin = 'payment'` queda reservado para la pasarela (no existe todavía).
 */
export const storageGrants = tenantTable(
  'storage_grants',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    kind: text('kind').notNull().default('grant'),
    planId: uuid('plan_id'),
    planName: text('plan_name').notNull(),
    extraBytes: bigint('extra_bytes', { mode: 'number' }).notNull(),
    priceAmount: numeric('price_amount', { precision: 14, scale: 2 }),
    currency: text('currency'),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at'),
    revokesGrantId: uuid('revokes_grant_id'),
    origin: text('origin').notNull().default('manual'),
    grantedBy: uuid('granted_by').references(() => users.id),
    reason: text('reason'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'storage_grants_revokes_fk', columns: [t['organizationId']!, t['revokesGrantId']!], foreignColumns: [t['organizationId']!, t['id']!] }),
    check('storage_grants_kind_valid', sql`${t['kind']!} IN ('grant', 'revoke')`),
    check('storage_grants_origin_valid', sql`${t['origin']!} IN ('manual', 'payment')`),
    check('storage_grants_shape', sql`(${t['kind']!} = 'grant' AND ${t['extraBytes']!} > 0 AND ${t['revokesGrantId']!} IS NULL) OR (${t['kind']!} = 'revoke' AND ${t['extraBytes']!} = 0 AND ${t['revokesGrantId']!} IS NOT NULL)`),
    check('storage_grants_period_valid', sql`${t['endsAt']!} IS NULL OR ${t['endsAt']!} > ${t['startsAt']!}`),
    check('storage_grants_bytes_valid', sql`${t['extraBytes']!} <= 10995116277760`),
    check('storage_grants_text_len', sql`length(btrim(${t['planName']!})) BETWEEN 1 AND 80 AND (${t['reason']!} IS NULL OR length(${t['reason']!}) <= 300) AND length(${t['idempotencyKey']!}) BETWEEN 8 AND 120`),
    uniqueIndex('storage_grants_org_idem_uq').on(t['organizationId']!, t['idempotencyKey']!),
    uniqueIndex('storage_grants_one_revoke_uq').on(t['organizationId']!, t['revokesGrantId']!).where(sql`${t['revokesGrantId']!} IS NOT NULL`),
    index('storage_grants_org_period_idx').on(t['organizationId']!, t['startsAt']!, t['endsAt']!),
  ],
);

/**
 * Solicitudes de más espacio que un administrador manda al Súper Admin (V21b). TABLA DE NEGOCIO (RLS forzada), sin DELETE: `open` → `granted` | `dismissed`. Una sola abierta por empresa.
 */
export const storageRequests = tenantTable(
  'storage_requests',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    requestedPlanId: uuid('requested_plan_id'),
    planName: text('plan_name'),
    status: text('status').notNull().default('open'),
    note: text('note'),
    requestedBy: uuid('requested_by').references(() => users.id),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: ts('resolved_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('storage_requests_status_valid', sql`${t['status']!} IN ('open', 'granted', 'dismissed')`),
    check('storage_requests_note_len', sql`${t['note']!} IS NULL OR length(${t['note']!}) <= 300`),
    check('storage_requests_resolved_consistent', sql`(${t['status']!} = 'open') = (${t['resolvedAt']!} IS NULL)`),
    uniqueIndex('storage_requests_one_open_uq').on(t['organizationId']!).where(sql`${t['status']!} = 'open'`),
    index('storage_requests_org_created_idx').on(t['organizationId']!, t['createdAt']!),
  ],
);

