import { sql } from 'drizzle-orm';
import { check, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Calendario de Google de una empresa (v11 Pista G, ADR-67). TABLA DE NEGOCIO: `organization_id` + RLS FORZADA; una sola fila por empresa. El refresh token de Google se guarda cifrado con
 * la bóveda de ADR-42, atado a SU empresa por el AAD `gcal/<empresa>`, y jamás se devuelve. De la cuenta solo se guarda una versión ENMASCARADA del correo (para que la persona reconozca cuál
 * conectó). Sin DELETE: al desconectar se borra el token y el estado pasa a `disconnected` (los eventos ya creados en Google se quedan allí).
 *
 * Estados: `pending_calendar` (modo «elegir uno existente»: ya hay autorización, falta elegir el calendario) · `connected` · `needs_reconnect` (Google rechazó el token) · `disconnected`.
 * Modos: `own` (Sales Smart crea y usa su propio calendario secundario) · `existing` (la persona elige uno que ya tenía).
 */
export const calendarConnections = tenantTable(
  'calendar_connections',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    /** Sobre cifrado con el refresh token. Nulo solo si está desconectada. */
    credentialsSealed: text('credentials_sealed'),
    keyVersion: integer('key_version'),
    /** ID del calendario donde se escribirán los eventos; nulo mientras falte elegirlo. */
    calendarId: text('calendar_id'),
    calendarName: text('calendar_name'),
    /** Correo de la cuenta de Google, enmascarado («j***@gmail.com»). */
    accountMasked: text('account_masked'),
    /** Alcances que Google concedió, separados por espacio. */
    scopes: text('scopes').notNull().default(''),
    /** Resultado de la última comprobación o llamada: null = bien. Texto seguro (nunca un token). */
    lastError: text('last_error'),
    lastCheckAt: ts('last_check_at'),
    connectedBy: uuid('connected_by').references(() => users.id),
    connectedAt: ts('connected_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('calendar_connections_org_uq').on(t['organizationId']!),
    check('calendar_connections_mode_valid', sql`${t['mode']!} IN ('own', 'existing')`),
    check('calendar_connections_status_valid', sql`${t['status']!} IN ('pending_calendar', 'connected', 'needs_reconnect', 'disconnected')`),
    check('calendar_connections_error_len', sql`${t['lastError']!} IS NULL OR length(${t['lastError']!}) <= 300`),
    check('calendar_connections_name_len', sql`${t['calendarName']!} IS NULL OR length(${t['calendarName']!}) <= 200`),
    // Con credenciales mientras esté conectada; sin ellas al desconectar
    check('calendar_connections_credentials_by_status', sql`(${t['status']!} = 'disconnected' AND ${t['credentialsSealed']!} IS NULL AND ${t['keyVersion']!} IS NULL) OR (${t['status']!} <> 'disconnected' AND ${t['credentialsSealed']!} IS NOT NULL AND ${t['keyVersion']!} IS NOT NULL)`),
    // Un calendario conectado tiene dónde escribir
    check('calendar_connections_calendar_when_connected', sql`${t['status']!} <> 'connected' OR ${t['calendarId']!} IS NOT NULL`),
  ],
);
