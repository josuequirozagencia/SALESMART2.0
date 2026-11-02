import { z } from 'zod';

/** Lista de avisos de la persona: solo los no leídos si se pide, con cursor por hora (lo más reciente primero). */
export const listNotificationsQuerySchema = z
  .object({
    unread: z.enum(['1', 'true']).transform(() => true).optional(),
    cursor: z.string().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
