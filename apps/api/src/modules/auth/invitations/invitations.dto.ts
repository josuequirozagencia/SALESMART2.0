import { isCountryCode } from '@sales-smart/shared';
import { z } from 'zod';
import { email, isValidTimezone, phoneE164 } from '../signup/signup.dto';

const name = z.string().trim().min(2).max(100).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');

/** Alta de empresa por el Súper Admin (F01). Zona horaria y país son obligatorios; el plan es opcional (sin plan, la prueba empieza al aceptar). */
export const createCompanySchema = z
  .object({
    name,
    owner_email: email,
    timezone: z.string().max(64).refine(isValidTimezone, 'zona horaria no válida'),
    country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'debe ser un código de país de 2 letras').refine(isCountryCode, 'país no válido'),
    plan_id: z.uuid().nullable().optional(),
  })
  .strict();
export type CreateCompanyDto = z.infer<typeof createCompanySchema>;

/** Alta de una agencia (ADR-40): igual que una empresa pero SIN plan (las agencias no pagan ni tienen prueba; el cliente paga su propio plan). */
export const createAgencySchema = createCompanySchema.omit({ plan_id: true });
export type CreateAgencyDto = z.infer<typeof createAgencySchema>;

export const invitationTokenSchema = z.object({ token: z.string().min(1).max(200) }).strict();
export type InvitationTokenDto = z.infer<typeof invitationTokenSchema>;

/**
 * Aceptar la invitación. Cuenta nueva: `full_name`, `phone` y `password` (la que define). Cuenta existente: solo `password` (la actual,
 * para confirmar la identidad); el servicio decide cuál caso es y exige lo que falte con un error de validación.
 */
export const acceptInvitationSchema = z
  .object({
    token: z.string().min(1).max(200),
    password: z.string().min(1).max(1024),
    full_name: name.optional(),
    phone: phoneE164.optional(),
  })
  .strict();
export type AcceptInvitationDto = z.infer<typeof acceptInvitationSchema>;
