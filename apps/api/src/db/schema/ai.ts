import { sql } from 'drizzle-orm';
import { check, index, integer, numeric, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { users } from './identity';
import { platformTable, tenantTable } from './helpers';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Monedero de créditos IA de la empresa (M8.1, ADR-19/ADR-53): uno por empresa. `balance_cache` es el saldo DERIVADO del libro (`ai_ledger`): solo lo cambia el servicio de créditos, dentro de la
 * misma transacción que el movimiento y con la fila bloqueada; nunca es un campo editable y jamás baja de cero. Sin DELETE.
 */
export const aiWallets = tenantTable(
  'ai_wallets',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    balanceCache: integer('balance_cache').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ai_wallets_org_uq').on(t['organizationId']!), check('ai_wallets_balance_valid', sql`${t['balanceCache']!} >= 0`)],
);

/**
 * Libro de movimientos de créditos (solo inserción: sin UPDATE ni DELETE). `credits` lleva signo: positivo para `welcome` y `grant`, negativo para `use` y `test`. `balance_after` es el saldo
 * tras el movimiento (lo que permite verificar el libro). `cost_usd` y `margin_pct` son SOLO del servidor: ninguna respuesta de cliente ni de agencia los devuelve (ADR-19).
 */
export const aiLedger = tenantTable(
  'ai_ledger',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    kind: text('kind').notNull(),
    credits: integer('credits').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    /** Qué lo originó (agente, prueba, nota del regalo…). Texto corto para la persona. */
    ref: text('ref'),
    /** Costo real en USD con 6 decimales (solo servidor). */
    costUsd: numeric('cost_usd', { precision: 14, scale: 6 }),
    /** Margen aplicado en ese momento (solo servidor). */
    marginPct: numeric('margin_pct', { precision: 7, scale: 2 }),
    /** Llave de idempotencia de los regalos (un reintento no los duplica); nula en los consumos. */
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('ai_ledger_kind_valid', sql`${t['kind']!} IN ('welcome', 'grant', 'use', 'test')`),
    check('ai_ledger_sign_by_kind', sql`(${t['kind']!} IN ('welcome', 'grant') AND ${t['credits']!} > 0) OR (${t['kind']!} IN ('use', 'test') AND ${t['credits']!} < 0)`),
    check('ai_ledger_balance_valid', sql`${t['balanceAfter']!} >= 0`),
    check('ai_ledger_ref_len', sql`${t['ref']!} IS NULL OR length(${t['ref']!}) <= 200`),
    check('ai_ledger_key_shape', sql`${t['idempotencyKey']!} IS NULL OR length(${t['idempotencyKey']!}) BETWEEN 8 AND 100`),
    uniqueIndex('ai_ledger_org_key_uq').on(t['organizationId']!, t['idempotencyKey']!).where(sql`${t['idempotencyKey']!} IS NOT NULL`),
    index('ai_ledger_recent_idx').on(t['organizationId']!, t['createdAt']!, t['id']!),
  ],
);

/**
 * Reserva de créditos antes de llamar al modelo (M8.1): se aparta el peor caso para que dos llamadas a la vez no gasten lo mismo. `active` → `settled` (se cobró lo usado y se liberó el resto),
 * `released` (no se usó) o `expired` (la tarea la liberó porque quedó colgada). El saldo disponible es `balance_cache` menos lo que suman las reservas activas. Sin DELETE.
 */
export const aiHolds = tenantTable(
  'ai_holds',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    credits: integer('credits').notNull(),
    kind: text('kind').notNull(),
    ref: text('ref'),
    status: text('status').notNull().default('active'),
    createdAt: ts('created_at').notNull().defaultNow(),
    settledAt: ts('settled_at'),
  },
  (t) => [
    check('ai_holds_credits_valid', sql`${t['credits']!} > 0`),
    check('ai_holds_kind_valid', sql`${t['kind']!} IN ('use', 'test')`),
    check('ai_holds_status_valid', sql`${t['status']!} IN ('active', 'settled', 'released', 'expired')`),
    check('ai_holds_ref_len', sql`${t['ref']!} IS NULL OR length(${t['ref']!}) <= 200`),
    index('ai_holds_active_idx').on(t['organizationId']!, t['createdAt']!).where(sql`${t['status']!} = 'active'`),
  ],
);

/**
 * Precio de los créditos (M8.1, tabla de PLATAFORMA: solo `app_platform`): una sola fila. `usd_per_credit` es lo que vale un crédito (ejemplo 0,01 USD) y `global_margin_pct`, el margen que se
 * suma al costo real (ejemplo 100 %). Ambos son valores de ejemplo hasta que el responsable cargue los reales (ADR-19).
 */
export const aiPricing = platformTable(
  'ai_pricing',
  {
    id: integer('id').primaryKey().default(1),
    usdPerCredit: numeric('usd_per_credit', { precision: 10, scale: 6 }).notNull().default('0.01'),
    globalMarginPct: numeric('global_margin_pct', { precision: 7, scale: 2 }).notNull().default('100'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [
    check('ai_pricing_singleton', sql`${t.id} = 1`),
    check('ai_pricing_price_valid', sql`${t.usdPerCredit} > 0 AND ${t.usdPerCredit} <= 100`),
    check('ai_pricing_margin_valid', sql`${t.globalMarginPct} >= 0 AND ${t.globalMarginPct} <= 1000`),
  ],
);

/** Margen propio de una empresa (sustituye al global). Tabla de PLATAFORMA. Sin fila = usa el global. */
export const aiOrgPricing = platformTable(
  'ai_org_pricing',
  {
    targetOrgId: uuid('target_org_id').primaryKey(),
    marginPct: numeric('margin_pct', { precision: 7, scale: 2 }).notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (t) => [check('ai_org_pricing_margin_valid', sql`${t.marginPct} >= 0 AND ${t.marginPct} <= 1000`)],
);
