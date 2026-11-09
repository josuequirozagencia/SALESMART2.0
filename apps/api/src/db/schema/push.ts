import { sql } from 'drizzle-orm';
import { boolean, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sales-smart/shared';
import { tenantTable } from './helpers';
import { users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Suscripciones push del navegador (v6 fase E, ADR-64). Una fila = un navegador de UNA persona en UNA empresa. TABLA DE NEGOCIO (tenant): `organization_id` + RLS FORZADA; SIN DELETE (al darse de baja o
 * cuando el servicio de push dice que el navegador ya no existe se marca `revoked_at`). El `endpoint` solo sirve con la clave privada VAPID del servidor, pero igual NUNCA se devuelve por la API
 * (el cliente solo sabe si está suscrito). `show_text` decide si la notificación lleva el texto del mensaje o solo «Mensaje nuevo» (por omisión no lo lleva: se ve en la pantalla bloqueada).
 */
export const pushSubscriptions = tenantTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().$defaultFn(uuidv7),
    userId: uuid('user_id').notNull().references(() => users.id),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    showText: boolean('show_text').notNull().default(false),
    userAgent: text('user_agent'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSentAt: ts('last_sent_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    // Un navegador (endpoint) está suscrito una sola vez por empresa; reactivarlo reutiliza la fila
    uniqueIndex('push_subscriptions_endpoint_uq').on(t['organizationId']!, t['endpoint']!),
    // Las suscripciones vigentes de una persona (para enviarle un aviso)
    index('push_subscriptions_user_idx').on(t['organizationId']!, t['userId']!).where(sql`${t['revokedAt']!} IS NULL`),
  ],
);
