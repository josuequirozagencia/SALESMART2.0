import { z } from 'zod';

export const loginSchema = z
  .object({
    email: z.string().min(3).max(254),
    password: z.string().min(1).max(1024),
    /** 'cookie' (web, por defecto): el refresh va en cookie HttpOnly. 'body': clientes nativos. */
    token_transport: z.enum(['cookie', 'body']).default('cookie'),
  })
  .strict();
export type LoginDto = z.infer<typeof loginSchema>;

export const tokenBodySchema = z.object({ refresh_token: z.string().min(1).max(200).optional() }).strict();
export type TokenBodyDto = z.infer<typeof tokenBodySchema>;
