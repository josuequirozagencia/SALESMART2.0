import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type DrizzleTx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];
declare const tenantBrand: unique symbol;
declare const platformBrand: unique symbol;
declare const identityBrand: unique symbol;

/**
 * Transacción con `app.org_id` fijado (SET LOCAL equivalente) para la organización del TenantContext.
 * El símbolo de marca NO se exporta: solo `Database.withTenant` puede producir este tipo (ADR-24 P9).
 */
export type TenantTx = DrizzleTx & { readonly [tenantBrand]: true };
/** Transacción de plataforma (rol app_platform; solo tablas de plataforma). Solo `Database.withPlatform`. */
export type PlatformTx = DrizzleTx & { readonly [platformBrand]: true };

/** Transacción de identidad (rol app_identity; solo tablas de identidad). Solo `Database.withIdentity` (ADR-25). */
export type IdentityTx = DrizzleTx & { readonly [identityBrand]: true };

export type { DrizzleTx };
