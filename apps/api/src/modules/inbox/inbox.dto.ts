import { z } from 'zod';

/** Largo máximo del texto de un mensaje de WhatsApp. */
export const MAX_MESSAGE_LENGTH = 4096;
/** Largo máximo de una nota interna. */
export const MAX_NOTE_LENGTH = 4000;

/** Texto de un mensaje o nota: sin espacios al borde, sin vacío y sin caracteres de control (salvo salto de línea y tabulación). */
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'escribe un mensaje')
    .max(max)
    .refine((v) => !/\p{Cc}/u.test(v.replace(/[\n\r\t]/g, '')), 'caracteres no permitidos');

export const replySchema = z.object({ text: text(MAX_MESSAGE_LENGTH) }).strict();
export type ReplyDto = z.infer<typeof replySchema>;

/** Enviar una plantilla: cuál y el valor de cada variable (clave = la `id` de la variable que informa la plantilla, p. ej. `body:1`). El servidor exige justo las que pide. */
export const sendTemplateSchema = z
  .object({
    template_id: z.uuid(),
    params: z.record(z.string().max(100), z.string().max(2000)).refine((p) => Object.keys(p).length <= 30, 'demasiadas variables').default({}),
  })
  .strict();
export type SendTemplateDto = z.infer<typeof sendTemplateSchema>;

export const noteSchema = z.object({ text: text(MAX_NOTE_LENGTH) }).strict();
export type NoteDto = z.infer<typeof noteSchema>;

/**
 * Pestañas del Inbox (M5.4): `working` = en curso (trabajando + esperando al cliente) · `pending` = por aceptar (y, para quien ve todo, las sin asignar) ·
 * `closed` = finalizadas.
 */
export const TABS = ['working', 'pending', 'closed'] as const;
export type InboxTab = (typeof TABS)[number];

const flag = z.enum(['1', 'true']).transform(() => true);

export const listConversationsQuerySchema = z
  .object({
    tab: z.enum(TABS).default('working'),
    /** Solo con `inbox.view_all`: sin él el alcance ya es propio. */
    owner: z.uuid().optional(),
    queue: z.uuid().optional(),
    channel: z.uuid().optional(),
    tag: z.uuid().optional(),
    unread: flag.optional(),
    /** Por el cronómetro de respuesta abierto: `late` vencido · `risk` en riesgo · `ok` al día (sin cronómetro o lejos de vencer). */
    sla: z.enum(['late', 'risk', 'ok']).optional(),
    /** Nombre o teléfono del contacto. */
    q: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const messagesQuerySchema = z
  .object({
    /** Para pedir los más antiguos: el `next_cursor` de la página anterior. */
    cursor: z.string().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type MessagesQuery = z.infer<typeof messagesQuerySchema>;
