import { z } from 'zod';

const name = z.string().trim().min(2, 'usa al menos 2 caracteres').max(100).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');
/** El teléfono se puede cambiar, pero no dejar vacío (ADR-76). */
const phone = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'debe estar en formato internacional, por ejemplo +593987654321');

/** El correo no se acepta (400): cambiarlo es un flujo de identidad aparte. */
export const updateMyProfileSchema = z
  .object({ full_name: name.optional(), phone: phone.optional() })
  .strict()
  .refine((v) => v.full_name !== undefined || v.phone !== undefined, 'envía al menos un dato');
export type UpdateMyProfileDto = z.infer<typeof updateMyProfileSchema>;
