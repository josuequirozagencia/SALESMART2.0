import { z } from 'zod';

/** Tope de productos por cola (M6.1): un catálogo más grande se vuelve inmanejable en un selector del chat. */
export const MAX_PRODUCTS_PER_QUEUE = 200;

const name = z.string().trim().min(1).max(120).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');
const kind = z.enum(['product', 'service']);
/** Precio en la moneda de la empresa: número o texto con hasta 2 decimales; se guarda exacto (`numeric(14,2)`), nunca como flotante. */
const price = z
  .union([z.number(), z.string().trim()])
  .transform((v) => (typeof v === 'number' ? String(v) : v))
  .refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(v), 'precio con hasta 2 decimales (máximo 999999999.99)')
  .transform((v) => Number(v).toFixed(2));

export const createProductSchema = z.object({ name, kind: kind.optional(), price, active: z.boolean().optional() }).strict();
export type CreateProductDto = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({ name: name.optional(), kind: kind.optional(), price: price.optional(), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateProductDto = z.infer<typeof updateProductSchema>;
