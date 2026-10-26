import { z } from 'zod';
import { MAX_GRANT_CREDITS } from './ai-credits.service';

/** Decimal como texto (sin errores de coma flotante): hasta 4 enteros y 6 decimales. */
const decimal = z.string().trim().regex(/^\d{1,4}(\.\d{1,6})?$/, 'un número con hasta 6 decimales');

export const creditsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
});
export type CreditsQuery = z.infer<typeof creditsQuerySchema>;

export const pricingSchema = z.strictObject({
  usd_per_credit: decimal.refine((v) => Number(v) > 0 && Number(v) <= 100, 'más de 0 y hasta 100'),
  global_margin_pct: decimal.refine((v) => Number(v) <= 1000, 'de 0 a 1000'),
});
export type PricingDto = z.infer<typeof pricingSchema>;

export const marginSchema = z.strictObject({ margin_pct: decimal.refine((v) => Number(v) <= 1000, 'de 0 a 1000').nullable() });
export type MarginDto = z.infer<typeof marginSchema>;

export const grantSchema = z.strictObject({
  credits: z.number().int().min(1).max(MAX_GRANT_CREDITS),
  /** Lo ve el cliente en sus movimientos: que sea un motivo claro y sin datos internos. */
  note: z.string().trim().min(3).max(150),
});
export type GrantDto = z.infer<typeof grantSchema>;

export const adminOrganizationsQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  state: z.enum(['trial', 'trial_expired', 'active', 'suspended', 'invited']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.uuid().optional(),
});
export type AdminOrganizationsQuery = z.infer<typeof adminOrganizationsQuerySchema>;

export const idempotencyKeySchema = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/, 'solo letras, números y _ . : -');

export const modelPriceSchema = z.strictObject({
  usd_per_1m_input: decimal.refine((v) => Number(v) <= 10000, 'de 0 a 10000'),
  usd_per_1m_output: decimal.refine((v) => Number(v) <= 10000, 'de 0 a 10000'),
});
export type ModelPriceDto = z.infer<typeof modelPriceSchema>;
export const modelParamSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
