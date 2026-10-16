import { z } from 'zod';

/** `target`: la organización a la que se quiere entrar, o `null` para volver al origen de la sesión («Volver a mi agencia»). */
export const switchContextSchema = z.object({ target: z.uuid().nullable() }).strict();
export type SwitchContextDto = z.infer<typeof switchContextSchema>;

export const contextOptionsQuerySchema = z.object({ q: z.string().trim().min(1).max(100).optional() }).strict();
export type ContextOptionsQuery = z.infer<typeof contextOptionsQuerySchema>;

export const listAccessSessionsQuerySchema = z
  .object({
    /** Quién entró: Súper Admin (soporte) o persona de agencia. */
    actor_role: z.enum(['super_admin', 'agency']).optional(),
    /** Texto en el correo o nombre de quien entró, o en el nombre de la organización a la que entró. */
    q: z.string().trim().min(1).max(100).optional(),
    /** Solo las entradas que siguen abiertas. */
    open: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    /** Cursor opaco devuelto como `next_cursor`. */
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ListAccessSessionsQuery = z.infer<typeof listAccessSessionsQuerySchema>;
