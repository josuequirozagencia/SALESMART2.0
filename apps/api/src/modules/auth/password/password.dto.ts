import { z } from 'zod';

const email = z.string().trim().max(254).pipe(z.email()).transform((v) => v.toLowerCase());

export const forgotSchema = z.object({ email, captcha_token: z.string().min(1).max(4096) }).strict();
export type ForgotDto = z.infer<typeof forgotSchema>;

export const resetSchema = z.object({ token: z.string().min(1).max(200), new_password: z.string().min(1).max(1024) }).strict();
export type ResetDto = z.infer<typeof resetSchema>;

export const changePasswordSchema = z.object({ current_password: z.string().min(1).max(1024), new_password: z.string().min(1).max(1024) }).strict();
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
