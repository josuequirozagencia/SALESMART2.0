import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable, identityTable } from './helpers';
import { organizations, users } from './identity';
import { queues } from './queues';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Canales de mensajería (M5.1, ADR-50). `channel_accounts` y `whatsapp_accounts` son TABLAS DE NEGOCIO (tenant): `organization_id` + RLS FORZADA.
 * `channel_routes` es de IDENTIDAD: el webhook de Meta llega sin sesión y hay que saber de qué empresa es el número antes de que exista contexto.
 */

/**
 * Conexión de una empresa a un canal. `meta_cloud` (WhatsApp oficial), `ghl` (GoHighLevel, M7.4: sin credenciales propias, usa las de `ghl_connections`) y `evolution` (QR, no oficial) reservado. Las credenciales viven SOLO
 * cifradas (`credentials_sealed`, bóveda de ADR-42) y no se devuelven nunca. Borrado LÓGICO.
 */
export const channelAccounts = tenantTable(
  'channel_accounts',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    provider: text('provider').notNull(),
    isOfficial: boolean('is_official').notNull().default(true),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    credentialsSealed: text('credentials_sealed'),
    keyVersion: integer('key_version'),
    /** Los últimos 4 caracteres del token, para mostrarlos; el valor completo no se puede leer. */
    tokenLast4: text('token_last4'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Cola por defecto de la conexión (M5.3): a dónde van las conversaciones nuevas de este número. Sin cola, quedan «sin asignar». */
    queueId: uuid('queue_id'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    check('channel_accounts_provider_valid', sql`${t['provider']!} IN ('meta_cloud', 'evolution', 'ghl')`),
    check('channel_accounts_status_valid', sql`${t['status']!} IN ('active', 'disabled')`),
    check('channel_accounts_name_shape', sql`length(btrim(${t['name']!})) BETWEEN 1 AND 60`),
    check('channel_accounts_last4_shape', sql`${t['tokenLast4']!} IS NULL OR length(${t['tokenLast4']!}) = 4`),
    check('channel_accounts_credentials_pair', sql`(${t['credentialsSealed']!} IS NULL) = (${t['keyVersion']!} IS NULL)`),
    foreignKey({ name: 'channel_accounts_queue_fk', columns: [t['organizationId']!, t['queueId']!], foreignColumns: [queues.organizationId, queues.id] }),
    // GoHighLevel (M7.4): un solo canal de GHL por empresa (el de su Location)
    uniqueIndex('channel_accounts_ghl_uq').on(t['organizationId']!).where(sql`${t['provider']!} = 'ghl' AND ${t['deletedAt']!} IS NULL`),
    uniqueIndex('channel_accounts_org_name_uq').on(t['organizationId']!, sql`lower(${t['name']!})`).where(sql`${t['deletedAt']!} IS NULL`),
  ],
);

/** Datos propios de un número de WhatsApp Cloud API. Uno por conexión. */
export const whatsappAccounts = tenantTable(
  'whatsapp_accounts',
  {
    channelAccountId: uuid('channel_account_id').notNull(),
    wabaId: text('waba_id').notNull(),
    phoneNumberId: text('phone_number_id').notNull(),
    /** false al desconectar el número: el mismo número puede volver a conectarse después. */
    active: boolean('active').notNull().default(true),
    displayPhone: text('display_phone'),
    verifiedName: text('verified_name'),
    lastCheckAt: ts('last_check_at'),
    lastError: text('last_error'),
    /** Última vez que Meta avisó de algo de este número (mensaje o estado): sirve para saber si el webhook está llegando. */
    lastEventAt: ts('last_event_at'),
    /** M5.6a: última sincronización de plantillas con Meta y, si la última falló, por qué (sin datos del cliente ni credenciales). */
    templatesSyncedAt: ts('templates_synced_at'),
    templatesSyncError: text('templates_sync_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('whatsapp_accounts_channel_uq').on(t['organizationId']!, t['channelAccountId']!),
    foreignKey({ name: 'whatsapp_accounts_channel_fk', columns: [t['organizationId']!, t['channelAccountId']!], foreignColumns: [channelAccounts.organizationId, channelAccounts.id] }),
    check('whatsapp_accounts_waba_shape', sql`${t['wabaId']!} ~ '^[0-9]{5,25}$'`),
    check('whatsapp_accounts_phone_id_shape', sql`${t['phoneNumberId']!} ~ '^[0-9]{5,25}$'`),
    check('whatsapp_accounts_error_len', sql`${t['lastError']!} IS NULL OR length(${t['lastError']!}) <= 300`),
    // Un número solo puede estar activo en UNA conexión de la empresa (en toda la plataforma lo garantiza `channel_routes`)
    uniqueIndex('whatsapp_accounts_phone_active_uq').on(t['organizationId']!, t['phoneNumberId']!).where(sql`${t['active']!}`),
  ],
);

/**
 * Ruta de un número de WhatsApp a su empresa (IDENTIDAD, sin RLS: el webhook la consulta antes de tener contexto). Un número solo puede estar activo en UNA empresa
 * (la clave primaria es el propio `phone_number_id`). Sin DELETE: al desconectar se desactiva, y reconectarlo lo reactiva.
 */
export const channelRoutes = identityTable(
  'channel_routes',
  {
    phoneNumberId: text('phone_number_id').primaryKey(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    channelAccountId: uuid('channel_account_id').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('channel_routes_phone_id_shape', sql`${t.phoneNumberId} ~ '^[0-9]{5,25}$'`),
    index('channel_routes_org_idx').on(t.organizationId),
  ],
);

/**
 * Sesión de WhatsApp por QR de una conexión `evolution` (M9.6, ADR-54/ADR-31; canal NO OFICIAL). Una por conexión. `instance_name` es el nombre de la instancia en Evolution (aleatorio, nunca el de la empresa).
 * `state`: `created` (sin vincular), `connecting` (esperando el QR o reconectando: NO es una caída), `open` (sesión activa), `logged_out` (el teléfono cerró la sesión: hay que escanear otro QR) y `closed` (se
 * cayó por otra razón). Las claves de Evolution NO viven aquí (la clave global es de la plataforma) y el token del webhook solo existe como hash en `qr_routes`.
 */
export const qrAccounts = tenantTable(
  'qr_accounts',
  {
    channelAccountId: uuid('channel_account_id').notNull(),
    instanceName: text('instance_name').notNull(),
    state: text('state').notNull().default('created'),
    phoneE164: text('phone_e164'),
    profileName: text('profile_name'),
    /** Primera vez que la sesión quedó abierta: de ahí corre el calentamiento de los límites de envío. */
    firstConnectedAt: ts('first_connected_at'),
    connectedAt: ts('connected_at'),
    /** Última vez que Evolution avisó de algo de esta sesión. */
    lastEventAt: ts('last_event_at'),
    /** Última vez que el latido consultó el estado de la sesión. */
    lastHeartbeatAt: ts('last_heartbeat_at'),
    lastError: text('last_error'),
    /** Desde cuándo está caída la sesión (para decir hace cuánto y para no avisar dos veces). */
    downSince: ts('down_since'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('qr_accounts_channel_uq').on(t['organizationId']!, t['channelAccountId']!),
    uniqueIndex('qr_accounts_instance_uq').on(t['instanceName']!),
    foreignKey({ name: 'qr_accounts_channel_fk', columns: [t['organizationId']!, t['channelAccountId']!], foreignColumns: [channelAccounts.organizationId, channelAccounts.id] }),
    check('qr_accounts_state_valid', sql`${t['state']!} IN ('created', 'connecting', 'open', 'logged_out', 'closed')`),
    check('qr_accounts_instance_shape', sql`${t['instanceName']!} ~ '^[a-z0-9-]{8,60}$'`),
    check('qr_accounts_error_len', sql`${t['lastError']!} IS NULL OR length(${t['lastError']!}) <= 300`),
  ],
);
