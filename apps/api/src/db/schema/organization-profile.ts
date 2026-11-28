import { sql } from 'drizzle-orm';
import { check, foreignKey, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenantTable } from './helpers';
import { organizations, users } from './identity';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Datos básicos del perfil de una empresa (V25, ADR-76): una fila por empresa, creada al primer guardado. TABLA DE NEGOCIO: `organization_id` + RLS FORZADA; sin DELETE. Todos los datos son
 * opcionales y son de la EMPRESA (no de una persona). El nombre, el país, la zona horaria y la moneda siguen en `organizations` (identidad).
 */
export const organizationProfiles = tenantTable(
  'organization_profiles',
  {
    legalName: text('legal_name'),
    taxId: text('tax_id'),
    contactPhone: text('contact_phone'),
    contactEmail: text('contact_email'),
    website: text('website'),
    address: text('address'),
    city: text('city'),
    description: text('description'),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'organization_profiles_pk', columns: [t['organizationId']!] }),
    foreignKey({ name: 'organization_profiles_org_fk', columns: [t['organizationId']!], foreignColumns: [organizations.id] }),
    check('organization_profiles_legal_name_len', sql`${t['legalName']!} IS NULL OR length(btrim(${t['legalName']!})) BETWEEN 1 AND 120`),
    check('organization_profiles_tax_id_len', sql`${t['taxId']!} IS NULL OR length(btrim(${t['taxId']!})) BETWEEN 1 AND 32`),
    check('organization_profiles_phone_e164', sql`${t['contactPhone']!} IS NULL OR ${t['contactPhone']!} ~ '^[+][1-9][0-9]{7,14}$'`),
    check('organization_profiles_email_shape', sql`${t['contactEmail']!} IS NULL OR (length(${t['contactEmail']!}) BETWEEN 3 AND 254 AND ${t['contactEmail']!} ~ '^[^@[:space:]]+@[^@[:space:]]+$')`),
    check('organization_profiles_website_https', sql`${t['website']!} IS NULL OR (length(${t['website']!}) <= 200 AND ${t['website']!} ~ '^https://[^[:space:]]+$')`),
    check('organization_profiles_address_len', sql`${t['address']!} IS NULL OR length(btrim(${t['address']!})) BETWEEN 1 AND 200`),
    check('organization_profiles_city_len', sql`${t['city']!} IS NULL OR length(btrim(${t['city']!})) BETWEEN 1 AND 80`),
    check('organization_profiles_description_len', sql`${t['description']!} IS NULL OR length(btrim(${t['description']!})) BETWEEN 1 AND 500`),
  ],
);
