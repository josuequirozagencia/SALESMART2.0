import { z } from 'zod';

const email = z.string().trim().max(254).pipe(z.email()).transform((v) => v.toLowerCase());
const captcha = z.string().min(1).max(4096);

const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return /^[A-Za-z0-9_+\-/]+$/.test(tz);
  } catch {
    return false;
  }
};

export const signupSchema = z
  .object({
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
