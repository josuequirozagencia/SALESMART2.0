import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, numeric, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { contacts } from './crm';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Pipelines, etapas y oportunidades (M4, ADR-49). TABLAS DE NEGOCIO (tenant): `organization_id` + RLS FORZADA por `tenantTable()`. Las reglas críticas las impone
 * la base de datos: una etapa ganada por pipeline, nombres únicos, una oportunidad abierta por contacto y pipeline, historial de etapas solo de inserción.
 */

/** Pipeline. Borrado LÓGICO (`app_rw` no tiene DELETE). `appointment_stage_id` = etapa de cita opcional (ADR-18): debe ser una etapa de ESTE pipeline. */
export const pipelines = tenantTable(
  'pipelines',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    appointmentStageId: uuid('appointment_stage_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('pipelines_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 60`),
    check('pipelines_position_valid', sql`${t['position']!} >= 0`),
    uniqueIndex('pipelines_org_name_uq').on(t['organizationId']!, sql`lower(${t['name']!})`).where(sql`${t['deletedAt']!} IS NULL`),
    // La clave foránea compuesta (organización, pipeline, etapa de cita) → pipeline_stages se declara en la migración de privilegios: es circular con
    // pipeline_stages_pipeline_fk y drizzle no puede tipar la referencia mutua.
  ],
);

/**
 * Etapa de un pipeline. `kind`: `open`, `won` (exactamente una por pipeline vigente) o `lost` (a lo sumo una). La ganada no se oculta. Borrado LÓGICO: el historial
 * de etapas sigue mostrando su nombre. `color` = clave de la paleta de 8 pasteles.
 */
export const pipelineStages = tenantTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    pipelineId: uuid('pipeline_id').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').notNull().default('open'),
    isHidden: boolean('is_hidden').notNull().default(false),
    color: text('color').notNull().default('blue'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({ name: 'pipeline_stages_pipeline_fk', columns: [t['organizationId']!, t['pipelineId']!], foreignColumns: [pipelines.organizationId, pipelines.id] }),
    // Para que otras tablas referencien (organización, pipeline, etapa) y la etapa no pueda ser de otro pipeline
    unique('pipeline_stages_org_pipeline_id_uq').on(t['organizationId']!, t['pipelineId']!, t['id']!),
    check('pipeline_stages_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 40`),
    check('pipeline_stages_kind_valid', sql`${t['kind']!} IN ('open', 'won', 'lost')`),
    check('pipeline_stages_color_valid', sql`${t['color']!} IN ('blue', 'teal', 'violet', 'amber', 'green', 'red', 'pink', 'gray')`),
    check('pipeline_stages_position_valid', sql`${t['position']!} >= 0`),
    check('pipeline_stages_won_visible', sql`NOT (${t['kind']!} = 'won' AND ${t['isHidden']!})`),
    uniqueIndex('pipeline_stages_name_uq').on(t['organizationId']!, t['pipelineId']!, sql`lower(${t['name']!})`).where(sql`${t['deletedAt']!} IS NULL`),
    uniqueIndex('pipeline_stages_one_won_uq').on(t['organizationId']!, t['pipelineId']!).where(sql`${t['kind']!} = 'won' AND ${t['deletedAt']!} IS NULL`),
    uniqueIndex('pipeline_stages_one_lost_uq').on(t['organizationId']!, t['pipelineId']!).where(sql`${t['kind']!} = 'lost' AND ${t['deletedAt']!} IS NULL`),
    index('pipeline_stages_pipeline_idx').on(t['organizationId']!, t['pipelineId']!, t['position']!).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/**
 * Oportunidad: un contacto en un pipeline. `status` es el tipo de su etapa actual (open|won|lost) y lo mantiene el servicio; `lost_reason` existe solo si está
 * perdida y `closed_at` solo si está cerrada. A lo sumo UNA abierta por contacto y pipeline. Borrado LÓGICO.
 */
export const opportunities = tenantTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    pipelineId: uuid('pipeline_id').notNull(),
    stageId: uuid('stage_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull().default('0'),
    currency: text('currency').notNull().default('USD'),
    ownerId: uuid('owner_id').references(() => users.id),
    status: text('status').notNull().default('open'),
    lostReason: text('lost_reason'),
    closedAt: ts('closed_at'),
    /** Cuándo entró a la etapa actual (ordena las tarjetas de una columna: la más reciente primero). */
    stageEnteredAt: ts('stage_entered_at').notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    foreignKey({ name: 'opportunities_pipeline_fk', columns: [t['organizationId']!, t['pipelineId']!], foreignColumns: [pipelines.organizationId, pipelines.id] }),
    foreignKey({ name: 'opportunities_stage_fk', columns: [t['organizationId']!, t['pipelineId']!, t['stageId']!], foreignColumns: [pipelineStages.organizationId, pipelineStages.pipelineId, pipelineStages.id] }),
    foreignKey({ name: 'opportunities_contact_fk', columns: [t['organizationId']!, t['contactId']!], foreignColumns: [contacts.organizationId, contacts.id] }),
    check('opportunities_status_valid', sql`${t['status']!} IN ('open', 'won', 'lost')`),
    check('opportunities_amount_valid', sql`${t['amount']!} >= 0`),
    check('opportunities_currency_valid', sql`${t['currency']!} ~ '^[A-Z]{3}$'`),
    check('opportunities_lost_reason_consistent', sql`(${t['status']!} = 'lost') = (${t['lostReason']!} IS NOT NULL)`),
    check('opportunities_lost_reason_len', sql`${t['lostReason']!} IS NULL OR length(btrim(${t['lostReason']!})) BETWEEN 1 AND 200`),
    check('opportunities_closed_consistent', sql`(${t['status']!} = 'open') = (${t['closedAt']!} IS NULL)`),
    uniqueIndex('opportunities_one_open_uq').on(t['organizationId']!, t['pipelineId']!, t['contactId']!).where(sql`${t['status']!} = 'open' AND ${t['deletedAt']!} IS NULL`),
    index('opportunities_stage_idx').on(t['organizationId']!, t['stageId']!, t['stageEnteredAt']!, t['id']!).where(sql`${t['deletedAt']!} IS NULL`),
    index('opportunities_contact_idx').on(t['organizationId']!, t['contactId']!).where(sql`${t['deletedAt']!} IS NULL`),
    index('opportunities_owner_idx').on(t['organizationId']!, t['ownerId']!).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/** Historial de etapas de una oportunidad. SOLO INSERCIÓN: `app_rw` no tiene UPDATE ni DELETE. `from_stage_id` es null en el alta. */
export const stageHistory = tenantTable(
  'stage_history',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    opportunityId: uuid('opportunity_id').notNull(),
    fromStageId: uuid('from_stage_id'),
    toStageId: uuid('to_stage_id').notNull(),
    userId: uuid('user_id').references(() => users.id),
    origin: text('origin').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'stage_history_opportunity_fk', columns: [t['organizationId']!, t['opportunityId']!], foreignColumns: [opportunities.organizationId, opportunities.id] }),
    foreignKey({ name: 'stage_history_from_fk', columns: [t['organizationId']!, t['fromStageId']!], foreignColumns: [pipelineStages.organizationId, pipelineStages.id] }),
    foreignKey({ name: 'stage_history_to_fk', columns: [t['organizationId']!, t['toStageId']!], foreignColumns: [pipelineStages.organizationId, pipelineStages.id] }),
    check('stage_history_origin_valid', sql`${t['origin']!} IN ('manual', 'ai', 'automation', 'ghl', 'meta', 'api', 'system')`),
    index('stage_history_opportunity_idx').on(t['organizationId']!, t['opportunityId']!, t['at']!),
  ],
);
