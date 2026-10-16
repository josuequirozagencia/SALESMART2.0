import { z } from 'zod';

const clean = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');

/**
 * Clic de Click-to-WhatsApp que manda GoHighLevel (o, después, Meta directo). El teléfono va en E.164. `occurred_at` no puede estar más de 5 minutos en el
 * futuro. Solo lo que declara este esquema entra: cualquier campo extra se rechaza.
 */
export const ctwaWebhookSchema = z
  .object({
    phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'debe estar en formato internacional, por ejemplo +593987654321'),
    ctwa_cl_id: clean(500),
    campaign_name: clean(200).optional(),
    adset_name: clean(200).optional(),
    ad_name: clean(200).optional(),
    source: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/).default('meta_ctwa'),
    occurred_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((b) => b.occurred_at === undefined || new Date(b.occurred_at).getTime() <= Date.now() + 5 * 60_000, { path: ['occurred_at'], message: 'no puede estar en el futuro' });
export type CtwaWebhookDto = z.infer<typeof ctwaWebhookSchema>;
