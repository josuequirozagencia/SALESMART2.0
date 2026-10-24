import { sql } from 'drizzle-orm';
import { check, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Conexión de una empresa con GoHighLevel (M7.1, ADR-52/ADR-05). TABLA DE NEGOCIO: `organization_id` + RLS FORZADA; una sola fila por empresa (una Location de GHL). El token
 * (Private Integration Token) se guarda cifrado con la bóveda de ADR-42, atado a SU empresa por el AAD `ghl/<empresa>`, y jamás se devuelve (solo sus últimos 4). `auth_type` deja
 * lugar a OAuth (ADR-05) sin tocar a quien lea la conexión. Sin DELETE: al desconectar se borra el token y el estado pasa a `disconnected`.
 */
export const ghlConnections = tenantTable(
  'ghl_connections',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    authType: text('auth_type').notNull().default('private_token'),
    /** Location (subcuenta) de GHL; solo letras y números. */
    locationId: text('location_id').notNull(),
    /** Sobre cifrado con el token. Nulo solo si está desconectada. */
    credentialsSealed: text('credentials_sealed'),
    keyVersion: integer('key_version'),
    tokenLast4: text('token_last4'),
    /** `active` | `needs_reconnect` (GHL rechazó el token) | `disconnected`. */
    status: text('status').notNull().default('active'),
    /** Resultado de la última comprobación o llamada: null = bien. Texto seguro (nunca el token). */
    lastError: text('last_error'),
    lastCheckAt: ts('last_check_at'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ghl_connections_org_uq').on(t['organizationId']!),
    check('ghl_connections_auth_type_valid', sql`${t['authType']!} IN ('private_token', 'oauth')`),
    check('ghl_connections_location_shape', sql`${t['locationId']!} ~ '^[A-Za-z0-9]{8,64}$'`),
    check('ghl_connections_status_valid', sql`${t['status']!} IN ('active', 'needs_reconnect', 'disconnected')`),
    check('ghl_connections_last4_shape', sql`${t['tokenLast4']!} IS NULL OR length(${t['tokenLast4']!}) BETWEEN 1 AND 4`),
    check('ghl_connections_error_len', sql`${t['lastError']!} IS NULL OR length(${t['lastError']!}) <= 300`),
    // Con credenciales mientras esté conectada; sin ellas al desconectar
    check('ghl_connections_credentials_by_status', sql`(${t['status']!} = 'disconnected' AND ${t['credentialsSealed']!} IS NULL AND ${t['keyVersion']!} IS NULL AND ${t['tokenLast4']!} IS NULL) OR (${t['status']!} <> 'disconnected' AND ${t['credentialsSealed']!} IS NOT NULL AND ${t['keyVersion']!} IS NOT NULL AND ${t['tokenLast4']!} IS NOT NULL)`),
  ],
);
