import { sql } from 'drizzle-orm';
import { boolean, check, date, foreignKey, index, integer, jsonb, numeric, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Campos personalizados tipados (M3.2, ADR-44). TABLAS DE NEGOCIO (tenant): `organization_id` + RLS FORZADA por `tenantTable()`.
 * La BD admite las tres entidades del Build Spec (contacto, oportunidad, empresa); la API de M3.2 solo acepta `contact`.
 */

/**
 * Definición de un campo. No se borra: se ARCHIVA (`archived_at`); su `var_key` (la variable `{{contact.clave}}`) queda reservada y no cambia nunca.
 * `options` solo existe en `select`/`multiselect`. Un campo obligatorio debe ser visible en el formulario. `app_rw` no tiene DELETE.
 */
export const customFieldDefinitions = tenantTable(
  'custom_field_definitions',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    entity: text('entity').notNull(),
    name: text('name').notNull(),
    varKey: text('var_key').notNull(),
    type: text('type').notNull(),
    options: jsonb('options').$type<string[]>(),
    required: boolean('required').notNull().default(false),
    showInForm: boolean('show_in_form').notNull().default(true),
    position: integer('position').notNull(),
    archivedAt: ts('archived_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Destino de la FK compuesta de los valores: un valor solo puede colgar de una definición de SU organización Y de su misma entidad
    unique('custom_field_definitions_org_id_entity_uq').on(t['organizationId']!, t['id']!, t['entity']!),
    uniqueIndex('custom_field_definitions_org_entity_key_uq').on(t['organizationId']!, t['entity']!, t['varKey']!),
    index('custom_field_definitions_org_entity_pos_idx').on(t['organizationId']!, t['entity']!, t['position']!, t['id']!),
    check('custom_field_definitions_entity_valid', sql`${t['entity']!} IN ('contact', 'opportunity', 'company')`),
    check('custom_field_definitions_type_valid', sql`${t['type']!} IN ('text', 'long_text', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean', 'email', 'phone', 'url', 'select', 'multiselect')`),
    check('custom_field_definitions_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 80`),
    check('custom_field_definitions_var_key_shape', sql`${t['varKey']!} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check(
      'custom_field_definitions_options_by_type',
      sql`(${t['type']!} IN ('select', 'multiselect') AND ${t['options']!} IS NOT NULL AND jsonb_typeof(${t['options']!}) = 'array' AND jsonb_array_length(${t['options']!}) BETWEEN 1 AND 50) OR (${t['type']!} NOT IN ('select', 'multiselect') AND ${t['options']!} IS NULL)`,
    ),
    check('custom_field_definitions_required_in_form', sql`NOT ${t['required']!} OR ${t['showInForm']!}`),
    check('custom_field_definitions_position_valid', sql`${t['position']!} >= 0`),
  ],
);

/**
 * Valor de un campo para una entidad. Una fila por (entidad, id de la entidad, definición) con columnas TIPADAS y a lo sumo UNA con valor:
 * vaciar un valor deja la fila con todo en NULL (`app_rw` no tiene DELETE; el historial queda en la auditoría). `entity_id` es polimórfico y no
 * tiene FK: el servicio comprueba que la entidad existe en la misma transacción.
 */
export const customFieldValues = tenantTable(
  'custom_field_values',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    definitionId: uuid('definition_id').notNull(),
    valueText: text('value_text'),
    valueNumber: numeric('value_number', { precision: 15, scale: 6 }),
    valueBool: boolean('value_bool'),
    valueDate: date('value_date', { mode: 'string' }),
    valueDatetime: ts('value_datetime'),
    valueJson: jsonb('value_json').$type<string[]>(),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'custom_field_values_definition_fk',
      columns: [t['organizationId']!, t['definitionId']!, t['entity']!],
      foreignColumns: [customFieldDefinitions.organizationId, customFieldDefinitions.id, customFieldDefinitions.entity],
    }),
    uniqueIndex('custom_field_values_org_entity_def_uq').on(t['organizationId']!, t['entity']!, t['entityId']!, t['definitionId']!),
    index('custom_field_values_org_def_idx').on(t['organizationId']!, t['definitionId']!),
    check('custom_field_values_entity_valid', sql`${t['entity']!} IN ('contact', 'opportunity', 'company')`),
    check(
      'custom_field_values_at_most_one',
      sql`num_nonnulls(${t['valueText']!}, ${t['valueNumber']!}, ${t['valueBool']!}, ${t['valueDate']!}, ${t['valueDatetime']!}, ${t['valueJson']!}) <= 1`,
    ),
    check('custom_field_values_json_is_array', sql`${t['valueJson']!} IS NULL OR jsonb_typeof(${t['valueJson']!}) = 'array'`),
  ],
);
