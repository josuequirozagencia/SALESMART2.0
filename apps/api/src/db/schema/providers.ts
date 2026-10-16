import { sql } from 'drizzle-orm';
import { check, integer, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { platformTable } from './helpers';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Credenciales de los proveedores de la PLATAFORMA (M2.6, ADR-42). Tabla de plataforma: solo `app_platform` (la API de cliente y de agencia no la
 * ve). Una fila por (servicio, proveedor). TODOS los valores del proveedor (claves, tokens, URL de la instancia, región…) se tratan como credenciales:
 * viajan cifrados en `secrets_sealed` (AES-256-GCM con clave de datos por fila envuelta por la clave maestra del servidor; ver `CredentialVault`) y NUNCA
 * se leen de vuelta; `secret_hints` guarda solo los últimos 4 caracteres de cada uno para mostrarlos.
 */
export const providerCredentials = platformTable(
  'provider_credentials',
  {
    service: text('service').notNull(),
    provider: text('provider').notNull(),
    /** Sobre cifrado `ss1:…` con todos los valores o NULL si el proveedor no tiene ninguno guardado. */
    secretsSealed: text('secrets_sealed'),
    /** Versión de la clave maestra con la que se envolvió (para rotarla). */
    keyVersion: integer('key_version'),
    /** { campo: últimos 4 | null }: qué valores hay y su sufijo visible (null = demasiado corto para mostrar nada). */
    secretHints: jsonb('secret_hints').notNull().default(sql`'{}'::jsonb`),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.service, t.provider], name: 'provider_credentials_pk' }),
    check('provider_credentials_service_shape', sql`${t.service} ~ '^[a-z][a-z0-9_]{1,40}$'`),
    check('provider_credentials_provider_shape', sql`${t.provider} ~ '^[a-z][a-z0-9_]{1,40}$'`),
    check('provider_credentials_sealed_consistent', sql`(${t.secretsSealed} IS NULL) = (${t.keyVersion} IS NULL)`),
    check('provider_credentials_key_version', sql`${t.keyVersion} IS NULL OR ${t.keyVersion} >= 1`),
    check('provider_credentials_hints_object', sql`jsonb_typeof(${t.secretHints}) = 'object'`),
  ],
);

/** Proveedor ACTIVO de cada servicio (`provider` NULL = ninguno). Tabla de plataforma. */
export const providerSelection = platformTable(
  'provider_selection',
  {
    service: text('service').primaryKey(),
    provider: text('provider'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
  },
  (t) => [
    check('provider_selection_service_shape', sql`${t.service} ~ '^[a-z][a-z0-9_]{1,40}$'`),
    check('provider_selection_provider_shape', sql`${t.provider} IS NULL OR ${t.provider} ~ '^[a-z][a-z0-9_]{1,40}$'`),
  ],
);
