import { z } from 'zod';

export const email = z.string().trim().max(254).pipe(z.email()).transform((v) => v.toLowerCase());
const captcha = z.string().min(1).max(4096);

export const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return /^[A-Za-z0-9_+\-/]+$/.test(tz);
  } catch {
    return false;
  }
};

/** Teléfono en E.164: «+» y de 8 a 15 dígitos, sin ceros iniciales tras el «+». La web arma el número con el prefijo del país. */
export const phoneE164 = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'debe estar en formato internacional, por ejemplo +593987654321');

export const signupSchema = z
  .object({
    full_name: z.string().trim().min(2).max(100).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos'),
    phone: phoneE164,
    email,
    password: z.string().min(1).max(1024),
    organization_name: z.string().trim().min(2).max(100).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos'),
    /** Zona horaria IANA del navegador. Si falta, la organización nace en UTC (editable luego). */
    timezone: z.string().max(64).refine(isValidTimezone, 'zona horaria no válida').optional(),
    captcha_token: captcha,
  })
  .strict();
export type SignupDto = z.infer<typeof signupSchema>;

export const verifySchema = z.object({ email, code: z.string().regex(/^\d{6}$/, 'debe tener 6 dígitos') }).strict();
export type VerifyDto = z.infer<typeof verifySchema>;

export const resendSchema = z.object({ email, captcha_token: captcha }).strict();
export type ResendDto = z.infer<typeof resendSchema>;
