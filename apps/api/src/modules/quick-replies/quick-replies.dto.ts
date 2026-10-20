import { z } from 'zod';

export const MAX_BODY = 4096;
export const MAX_QUICK_REPLIES_PER_SCOPE = 200;

/** Lo que se escribe tras la barra: se acepta con o sin «/», con mayúsculas o espacios sobrantes, y se guarda limpio. */
const shortcut = z
  .string()
  .trim()
  .transform((v) => v.replace(/^\/+/, '').toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'Usa letras sin tilde, números, guion o guion bajo (máximo 32)'));

// Sin caracteres de control salvo el salto de línea y la tabulación
const body = z
  .string()
  .trim()
  .min(1, 'Escribe el mensaje')
  .max(MAX_BODY, `Máximo ${MAX_BODY} caracteres`)
  .refine((v) => !/[^\P{Cc}\n\r\t]/u.test(v), 'caracteres no permitidos');

export const createQuickReplySchema = z.object({ shortcut, body, shared: z.boolean().optional() }).strict();
export type CreateQuickReplyDto = z.infer<typeof createQuickReplySchema>;

export const updateQuickReplySchema = z
  .object({ shortcut: shortcut.optional(), body: body.optional(), shared: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateQuickReplyDto = z.infer<typeof updateQuickReplySchema>;
