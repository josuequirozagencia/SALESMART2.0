import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, numeric, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { conversations } from './conversations';
import { contacts } from './crm';
import { tenantTable } from './helpers';
import { users } from './identity';
import { opportunities } from './pipelines';
import { queueProducts, queues } from './queues';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Ventas (M6.2, ADR-08/18/32/51). TABLAS DE NEGOCIO (tenant): `organization_id` + RLS FORZADA. Una venta es una línea (un producto del catálogo de la cola, cantidad y
 * TOTAL). Nunca se borra ni se edita su valor: se ANULA (con motivo) y el saldo es DERIVADO (`amount` − abonos + correcciones), jamás un campo. Los abonos, el historial de
 * estados y las solicitudes de corrección son solo de inserción. `app_rw` no tiene DELETE en ninguna de las cuatro.
 */
export const sales = tenantTable(
  'sales',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    contactId: uuid('contact_id').notNull(),
    conversationId: uuid('conversation_id'),
    /** La oportunidad que esta venta ganó (si el contacto tenía una abierta). */
    opportunityId: uuid('opportunity_id'),
    queueId: uuid('queue_id').notNull(),
    productId: uuid('product_id').notNull(),
    /** Foto del producto al vender: renombrarlo o cambiarle el precio después no altera ventas pasadas. */
    productName: text('product_name').notNull(),
    productKind: text('product_kind').notNull(),
    quantity: integer('quantity').notNull().default(1),
    /** TOTAL de la venta (lo que se informa a Meta y sobre lo que se calculará la comisión, ADR-18). */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    /** active → cancelled. */
    status: text('status').notNull().default('active'),
    /** Quien se lleva la venta: el dueño de la conversación al vender (el «dueño del lead», ADR-18). */
    sellerId: uuid('seller_id').notNull().references(() => users.id),
    note: text('note'),
    /** `Idempotency-Key` de la petición que la creó: repetirla devuelve la misma venta. */
    idempotencyKey: text('idempotency_key').notNull(),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelReason: text('cancel_reason'),
    /** Qué había pasado con el Purchase a Meta cuando se anuló: `cancelled` (no salió), `sent` (ya había salido), `skipped` o `none`. */
    purchaseAtCancel: text('purchase_at_cancel'),
  },
  (t) => [
    foreignKey({ name: 'sales_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    foreignKey({ name: 'sales_conversation_fk', columns: [t['organizationId']!, t['conversationId']!], foreignColumns: [conversations.organizationId, conversations.id] }),
    foreignKey({ name: 'sales_opportunity_fk', columns: [t['organizationId']!, t['opportunityId']!], foreignColumns: [opportunities.organizationId, opportunities.id] }),
    foreignKey({ name: 'sales_queue_fk', columns: [t['organizationId']!, t['queueId']!], foreignColumns: [queues.organizationId, queues.id] }),
    foreignKey({ name: 'sales_product_fk', columns: [t['organizationId']!, t['productId']!], foreignColumns: [queueProducts.organizationId, queueProducts.id] }),
    check('sales_amount_valid', sql`${t['amount']!} > 0 AND ${t['amount']!} < 1000000000`),
    check('sales_quantity_valid', sql`${t['quantity']!} BETWEEN 1 AND 9999`),
    check('sales_currency_shape', sql`${t['currency']!} ~ '^[A-Z]{3}$'`),
    check('sales_status_valid', sql`${t['status']!} IN ('active', 'cancelled')`),
    check('sales_product_kind_valid', sql`${t['productKind']!} IN ('product', 'service')`),
    check('sales_note_len', sql`${t['note']!} IS NULL OR length(${t['note']!}) BETWEEN 1 AND 500`),
    check('sales_key_shape', sql`length(${t['idempotencyKey']!}) BETWEEN 8 AND 100`),
    check('sales_purchase_at_cancel_valid', sql`${t['purchaseAtCancel']!} IS NULL OR ${t['purchaseAtCancel']!} IN ('cancelled', 'sent', 'skipped', 'none')`),
    // Anulada ⇔ con fecha, autor y motivo
    check('sales_cancel_consistent', sql`(${t['status']!} = 'cancelled') = (${t['cancelledAt']!} IS NOT NULL AND ${t['cancelledBy']!} IS NOT NULL AND ${t['cancelReason']!} IS NOT NULL)`),
    check('sales_cancel_reason_len', sql`${t['cancelReason']!} IS NULL OR length(btrim(${t['cancelReason']!})) BETWEEN 1 AND 500`),
    uniqueIndex('sales_org_key_uq').on(t['organizationId']!, t['idempotencyKey']!),
    index('sales_contact_idx').on(t['organizationId']!, t['contactId']!, t['createdAt']!),
    index('sales_seller_idx').on(t['organizationId']!, t['sellerId']!, t['createdAt']!),
    index('sales_created_idx').on(t['organizationId']!, t['createdAt']!),
  ],
);

/**
 * Abonos de una venta (solo inserción). `payment` suma lo cobrado; `correction` lo resta (un abono mal registrado lo corrige un administrador con motivo, sin borrar
 * ni editar nada). Los montos son siempre positivos: el tipo da el signo. El saldo de la venta es `amount − Σ payment + Σ correction` (derivado).
 */
export const salePayments = tenantTable(
  'sale_payments',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    saleId: uuid('sale_id').notNull(),
    kind: text('kind').notNull().default('payment'),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    method: text('method'),
    note: text('note'),
    /** Obligatorio en una corrección. */
    reason: text('reason'),
    /** `Idempotency-Key` de la petición (null para el abono inicial, que viaja con la venta). */
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').notNull().references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'sale_payments_sale_fk', columns: [t['organizationId']!, t['saleId']!], foreignColumns: [sales.organizationId, sales.id] }),
    check('sale_payments_kind_valid', sql`${t['kind']!} IN ('payment', 'correction')`),
    check('sale_payments_amount_valid', sql`${t['amount']!} > 0 AND ${t['amount']!} < 1000000000`),
    check('sale_payments_method_valid', sql`${t['method']!} IS NULL OR ${t['method']!} IN ('cash', 'transfer', 'card', 'other')`),
    // Un abono lleva método; una corrección, motivo
    check('sale_payments_shape', sql`(${t['kind']!} = 'payment' AND ${t['method']!} IS NOT NULL) OR (${t['kind']!} = 'correction' AND ${t['reason']!} IS NOT NULL AND length(btrim(${t['reason']!})) BETWEEN 1 AND 500)`),
    check('sale_payments_note_len', sql`${t['note']!} IS NULL OR length(${t['note']!}) BETWEEN 1 AND 500`),
    uniqueIndex('sale_payments_org_key_uq').on(t['organizationId']!, t['idempotencyKey']!).where(sql`${t['idempotencyKey']!} IS NOT NULL`),
    index('sale_payments_sale_idx').on(t['organizationId']!, t['saleId']!, t['createdAt']!),
  ],
);

/** Historial de estados de una venta (solo inserción, nunca se borra: ADR-08). */
export const saleStatusHistory = tenantTable(
  'sale_status_history',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    saleId: uuid('sale_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    reason: text('reason'),
    actorId: uuid('actor_id').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'sale_status_history_sale_fk', columns: [t['organizationId']!, t['saleId']!], foreignColumns: [sales.organizationId, sales.id] }),
    check('sale_status_history_status_valid', sql`${t['toStatus']!} IN ('active', 'cancelled') AND (${t['fromStatus']!} IS NULL OR ${t['fromStatus']!} IN ('active', 'cancelled'))`),
    index('sale_status_history_sale_idx').on(t['organizationId']!, t['saleId']!, t['createdAt']!),
  ],
);

/**
 * Solicitudes de corrección (ADR-32): el asesor no modifica una venta; pide que un administrador la corrija. `open` → `resolved` o `dismissed`. Solo se crean y se
 * resuelven (nunca se borran).
 */
export const saleChangeRequests = tenantTable(
  'sale_change_requests',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    saleId: uuid('sale_id').notNull(),
    requestedBy: uuid('requested_by').notNull().references(() => users.id),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('open'),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: ts('resolved_at'),
    resolutionNote: text('resolution_note'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'sale_change_requests_sale_fk', columns: [t['organizationId']!, t['saleId']!], foreignColumns: [sales.organizationId, sales.id] }),
    check('sale_change_requests_status_valid', sql`${t['status']!} IN ('open', 'resolved', 'dismissed')`),
    check('sale_change_requests_reason_len', sql`length(btrim(${t['reason']!})) BETWEEN 1 AND 500`),
    check('sale_change_requests_note_len', sql`${t['resolutionNote']!} IS NULL OR length(${t['resolutionNote']!}) <= 500`),
    check('sale_change_requests_resolved_consistent', sql`(${t['status']!} = 'open') = (${t['resolvedAt']!} IS NULL AND ${t['resolvedBy']!} IS NULL)`),
    index('sale_change_requests_sale_idx').on(t['organizationId']!, t['saleId']!, t['createdAt']!),
    index('sale_change_requests_open_idx').on(t['organizationId']!, t['createdAt']!).where(sql`${t['status']!} = 'open'`),
  ],
);
