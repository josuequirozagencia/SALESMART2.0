import { z } from 'zod';

/** Dinero: número o texto con hasta 2 decimales; se guarda exacto (`numeric(14,2)`), nunca como flotante. Siempre se devuelve como texto de 2 decimales. */
const money = z
  .union([z.number(), z.string().trim()])
  .transform((v) => (typeof v === 'number' ? String(v) : v))
  .refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(v), 'monto con hasta 2 decimales (máximo 999999999.99)')
  .transform((v) => Number(v).toFixed(2));
const positive = money.refine((v) => Number(v) > 0, 'el monto debe ser mayor que 0');

export const PAYMENT_METHODS = ['cash', 'transfer', 'card', 'other'] as const;
const method = z.enum(PAYMENT_METHODS);
const text500 = z.string().trim().min(1).max(500).refine((v) => !/\p{Cc}/u.test(v.replace(/[\n\t]/g, '')), 'caracteres no permitidos');

/** `Idempotency-Key` de la petición: repetirla devuelve el mismo resultado (doble clic, reintento de red). */
export const idempotencyKeySchema = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/, 'solo letras, números y _ . : -');

export const createSaleSchema = z
  .object({
    conversation_id: z.uuid(),
    product_id: z.uuid(),
    quantity: z.number().int().min(1).max(9999).optional(),
    /** TOTAL de la venta (no el precio unitario): lo que se informa a Meta. */
    amount: positive,
    /** Abono inicial (0 = ninguno). */
    down_payment: money.optional(),
    method: method.optional(),
    note: text500.optional(),
  })
  .strict()
  .refine((b) => b.down_payment === undefined || Number(b.down_payment) === 0 || b.method !== undefined, { message: 'indica el método de pago del abono', path: ['method'] })
  .refine((b) => b.down_payment === undefined || Number(b.down_payment) <= Number(b.amount), { message: 'el abono no puede ser mayor que el total', path: ['down_payment'] });
export type CreateSaleDto = z.infer<typeof createSaleSchema>;

export const paymentSchema = z.object({ amount: positive, method, note: text500.optional() }).strict();
export type PaymentDto = z.infer<typeof paymentSchema>;

export const correctionSchema = z.object({ amount: positive, reason: text500 }).strict();
export type CorrectionDto = z.infer<typeof correctionSchema>;

export const cancelSchema = z.object({ reason: text500 }).strict();
export type CancelDto = z.infer<typeof cancelSchema>;

export const changeRequestSchema = z.object({ reason: text500 }).strict();
export type ChangeRequestDto = z.infer<typeof changeRequestSchema>;

export const resolveRequestSchema = z.object({ status: z.enum(['resolved', 'dismissed']), note: text500.optional() }).strict();
export type ResolveRequestDto = z.infer<typeof resolveRequestSchema>;

export const listSalesQuerySchema = z
  .object({
    status: z.enum(['active', 'cancelled']).optional(),
    contact_id: z.uuid().optional(),
    seller_id: z.uuid().optional(),
    collected: z.enum(['yes', 'no']).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
export type ListSalesQuery = z.infer<typeof listSalesQuerySchema>;

export const optionsQuerySchema = z.object({ conversation_id: z.uuid() }).strict();
export type OptionsQuery = z.infer<typeof optionsQuerySchema>;

export const requestsQuerySchema = z.object({ status: z.enum(['open', 'resolved', 'dismissed']).optional() }).strict();
export type RequestsQuery = z.infer<typeof requestsQuerySchema>;

/** Monedas aceptadas: las que reconoce el motor de formato (ISO 4217). */
export const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((c) => /^[A-Z]{3}$/.test(c) && Intl.supportedValuesOf('currency').includes(c), 'moneda no válida (código ISO de 3 letras, por ejemplo USD)');
export const settingsSchema = z.object({ currency: currencySchema }).strict();
export type SettingsDto = z.infer<typeof settingsSchema>;

export const MAX_OPEN_REQUESTS_PER_SALE = 5;
