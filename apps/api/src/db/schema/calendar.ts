import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { appointments } from './appointments';
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

/**
 * Vínculo cita → evento de Google Calendar (v11 Pista G, 67b, ADR-67). TABLA DE NEGOCIO: RLS FORZADA, sin DELETE; una fila por cita. NO es una cola de operaciones: guarda el ESTADO DESEADO
 * («esta cita cambió, hay que reconciliarla») y la tarea compara la cita de ahora con el evento de Google: crea, actualiza o borra según corresponda. Así no hay órdenes que se desordenen ni se
 * repitan. `seq` sube cada vez que la cita cambia: la tarea solo da por sincronizado lo que leyó si `seq` no cambió mientras hablaba con Google.
 *
 * Estados: `pending` (hay que sincronizar) · `synced` · `failed` (falló definitivamente o agotó los intentos; se puede reintentar) · `gone` (la persona borró el evento en Google: se respeta y
 * no se vuelve a crear). `event_id` es DETERMINISTA (derivado del id de la cita): si la tarea muere entre crear el evento y anotarlo, el reintento no duplica nada.
 */
export const appointmentCalendarEvents = tenantTable(
  'appointment_calendar_events',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    appointmentId: uuid('appointment_id').notNull(),
    /** Calendario de Google donde vive el evento (puede diferir del actual si la empresa cambió de calendario). */
    calendarId: text('calendar_id'),
    eventId: text('event_id'),
    etag: text('etag'),
    syncState: text('sync_state').notNull().default('pending'),
    seq: integer('seq').notNull().default(1),
    /** Cuántas veces se borró a propósito el evento de esta cita (al apagar «Crear evento en Google Calendar»): cada generación usa un id nuevo, porque Google no deja reutilizar el de un evento borrado. */
    generation: integer('generation').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    /** Arrendamiento: la tarea que lo tomó (se retoma si murió a medias). */
    processingStartedAt: ts('processing_started_at'),
    /** Último fallo, en texto seguro (nunca un token ni datos de la cita). */
    lastError: text('last_error'),
    syncedAt: ts('synced_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: 'appointment_calendar_events_appointment_fk', columns: [t['organizationId']!, t['appointmentId']!], foreignColumns: [appointments.organizationId, appointments.id] }),
    uniqueIndex('appointment_calendar_events_appointment_uq').on(t['organizationId']!, t['appointmentId']!),
    index('appointment_calendar_events_due_idx').on(t['organizationId']!, t['syncState']!, t['nextAttemptAt']!),
    check('appointment_calendar_events_state_valid', sql`${t['syncState']!} IN ('pending', 'synced', 'failed', 'gone')`),
    check('appointment_calendar_events_error_len', sql`${t['lastError']!} IS NULL OR length(${t['lastError']!}) <= 300`),
    check('appointment_calendar_events_attempts_valid', sql`${t['attempts']!} >= 0`),
  ],
);
