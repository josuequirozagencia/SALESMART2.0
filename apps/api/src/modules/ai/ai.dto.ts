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

/** Topes diarios de la IA por empresa (cada uno de 1 a 10 000; el servidor y la base los validan). */
const limit = z.number().int().min(1).max(10_000);
export const limitsSchema = z.strictObject({
  tests_per_day: limit,
  suggestions_per_day: limit,
  follow_ups_per_day: limit,
  /** Los tres siguientes son de v13 S5 (ADR-70): si no vienen, se conserva el valor actual. */
  transcriptions_per_day: limit.optional(),
  images_per_day: limit.optional(),
  audio_max_seconds: z.number().int().min(15).max(300).optional(),
});
export type LimitsDto = z.infer<typeof limitsSchema>;

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
  /** Un modelo de chat o de embeddings lleva los dos precios por tokens; uno de transcripción, solo `usd_per_minute` (se comprueba contra el tipo del modelo en el servicio). */
  usd_per_1m_input: decimal.refine((v) => Number(v) <= 10000, 'de 0 a 10000').optional(),
  usd_per_1m_output: decimal.refine((v) => Number(v) <= 10000, 'de 0 a 10000').optional(),
  usd_per_minute: decimal.refine((v) => Number(v) <= 10000, 'de 0 a 10000').optional(),
  /** ¿El modelo de chat entiende imágenes? (ADR-70). Si no viene, se conserva. */
  vision: z.boolean().optional(),
});
export type ModelPriceDto = z.infer<typeof modelPriceSchema>;
export const modelParamSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
/** Dar de alta un modelo de chat (v11 S4): su nombre exacto en el proveedor y su precio. */
export const createModelSchema = z
  .strictObject({
    model: modelParamSchema,
    /** `chat` (por omisión) o `transcription` (v13 S5b, ADR-70: se cobra por minuto de audio). */
    kind: z.enum(['chat', 'transcription']).default('chat'),
    usd_per_1m_input: decimal.refine((v) => Number(v) <= 10000, 'de 0 a 10000').optional(),
    usd_per_1m_output: decimal.refine((v) => Number(v) <= 10000, 'de 0 a 10000').optional(),
    vision: z.boolean().optional(),
    usd_per_minute: decimal.refine((v) => Number(v) <= 10000, 'de 0 a 10000').optional(),
  })
  .superRefine((b, ctx) => {
    if (b.kind === 'chat') {
      if (b.usd_per_1m_input === undefined) ctx.addIssue({ code: 'custom', path: ['usd_per_1m_input'], message: 'Falta el precio de entrada' });
      if (b.usd_per_1m_output === undefined) ctx.addIssue({ code: 'custom', path: ['usd_per_1m_output'], message: 'Falta el precio de salida' });
      if (b.usd_per_minute !== undefined) ctx.addIssue({ code: 'custom', path: ['usd_per_minute'], message: 'El precio por minuto es solo de los modelos de transcripción' });
    } else {
      if (b.usd_per_minute === undefined) ctx.addIssue({ code: 'custom', path: ['usd_per_minute'], message: 'Falta el precio por minuto de audio' });
      if (b.usd_per_1m_input !== undefined || b.usd_per_1m_output !== undefined || b.vision !== undefined) ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Un modelo de transcripción solo lleva su precio por minuto' });
    }
  });
export type CreateModelDto = z.infer<typeof createModelSchema>;
