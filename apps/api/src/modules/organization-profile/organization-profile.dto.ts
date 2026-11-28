import { isCountryCode } from '@sales-smart/shared';
import { z } from 'zod';
import { isValidTimeZone } from '../../time/zone';

/** Sin caracteres de control (salvo salto de línea y tabulación, que solo admite la descripción). */
const clean = (v: string): boolean => !/\p{Cc}/u.test(v);

const name = z.string().trim().min(2, 'usa al menos 2 caracteres').max(100).refine(clean, 'caracteres no permitidos');

/** Un dato opcional: sin espacios al borde; vacío o `null` lo borra. */
const optional = <T extends z.ZodType<string>>(inner: T) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v), inner.nullable()).optional();
const line = (max: number) => z.string().max(max).refine(clean, 'caracteres no permitidos');

export const updateProfileSchema = z
  .object({
    name: name.optional(),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'debe ser un código de país de 2 letras').refine(isCountryCode, 'país no válido').optional(),
    timezone: z.string().max(64).refine(isValidTimeZone, 'zona horaria no válida').optional(),
    legal_name: optional(line(120)),
    tax_id: optional(line(32)),
    contact_phone: optional(z.string().regex(/^\+[1-9]\d{7,14}$/, 'debe estar en formato internacional, por ejemplo +593987654321')),
    contact_email: optional(z.email('escribe un correo válido').max(254)),
    website: optional(z.string().max(200).regex(/^https:\/\/[^\s]+$/, 'debe empezar por https://').refine((v) => URL.canParse(v), 'dirección no válida')),
    address: optional(line(200)),
    city: optional(line(80)),
    description: optional(z.string().max(500).refine((v) => !/\p{Cc}/u.test(v.replace(/[\n\r\t]/g, '')), 'caracteres no permitidos')),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'envía al menos un dato');
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;
