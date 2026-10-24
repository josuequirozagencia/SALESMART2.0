import { sql } from 'drizzle-orm';
import { boolean, check, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Conexión de una empresa con la API de Conversiones de Meta (M6.4, ADR-45 #5/ADR-51): el dataset (pixel) y su token, cifrados con la bóveda de ADR-42 y atados a SU empresa
 * por el AAD (`meta/<empresa>`), más la ventana de gracia del Purchase. TABLA DE NEGOCIO (tenant): `organization_id` + RLS FORZADA; una sola fila por empresa. Sin DELETE: se
 * apaga (`enabled`). El token jamás se devuelve (solo sus últimos 4) ni se registra.
 */
export const metaSettings = tenantTable(
  'meta_settings',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    datasetId: text('dataset_id').notNull(),
    /** Sobre cifrado con el token de acceso. */
    credentialsSealed: text('credentials_sealed').notNull(),
    keyVersion: integer('key_version').notNull(),
    tokenLast4: text('token_last4').notNull(),
    /** Espera antes de enviar el Purchase: si la venta se anula dentro de ella, Meta nunca lo recibe (ADR-18). 0 = enviarlo al instante; máximo 24 h. */
    graceMinutes: integer('grace_minutes').notNull().default(30),
    /** Código de «Eventos de prueba» de Events Manager: con él, Meta muestra los eventos en esa pestaña y no los cuenta. */
    testEventCode: text('test_event_code'),
    enabled: boolean('enabled').notNull().default(true),
    /** Resultado de la última comprobación o envío: null = bien. Texto seguro (nunca el token). */
    lastError: text('last_error'),
    lastCheckAt: ts('last_check_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('meta_settings_dataset_shape', sql`${t['datasetId']!} ~ '^[0-9]{5,30}$'`),
    check('meta_settings_grace_valid', sql`${t['graceMinutes']!} BETWEEN 0 AND 1440`),
    check('meta_settings_test_code_shape', sql`${t['testEventCode']!} IS NULL OR ${t['testEventCode']!} ~ '^[A-Za-z0-9_-]{1,40}$'`),
    check('meta_settings_last4_shape', sql`length(${t['tokenLast4']!}) BETWEEN 1 AND 4`),
    check('meta_settings_error_len', sql`${t['lastError']!} IS NULL OR length(${t['lastError']!}) <= 300`),
    uniqueIndex('meta_settings_org_uq').on(t['organizationId']!),
  ],
);
