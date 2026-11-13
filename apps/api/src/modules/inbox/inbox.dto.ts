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

/** Responder con texto. `reply_to_message_id`: cita un mensaje de la misma conversación (v13 S3.3); el servidor valida que exista, no sea una nota y ya haya salido. */
export const replySchema = z.object({ text: text(MAX_MESSAGE_LENGTH), reply_to_message_id: z.uuid().optional() }).strict();
export type ReplyDto = z.infer<typeof replySchema>;

/** Reaccionar a un mensaje del cliente: un emoji (un solo símbolo, quizá con modificadores) o vacío/null para quitar la reacción. */
export const reactionSchema = z
  .object({
    emoji: z
      .string()
      .max(16)
      .refine((v) => v === '' || /\p{Extended_Pictographic}/u.test(v), 'debe ser un emoji')
      .nullable(),
  })
  .strict();
export type ReactionDto = z.infer<typeof reactionSchema>;

/** Enviar un adjunto ya subido ( `attachment_id` de `POST …/attachments` ), con pie opcional. */
export const sendMediaSchema = z.object({ attachment_id: z.uuid(), caption: z.string().trim().max(1024).optional() }).strict();
export type SendMediaDto = z.infer<typeof sendMediaSchema>;

/** Enviar una plantilla: cuál y el valor de cada variable (clave = la `id` de la variable que informa la plantilla, p. ej. `body:1`). El servidor exige justo las que pide. */
export const sendTemplateSchema = z
  .object({
    template_id: z.uuid(),
    params: z.record(z.string().max(100), z.string().max(2000)).refine((p) => Object.keys(p).length <= 30, 'demasiadas variables').default({}),
  })
  .strict();
export type SendTemplateDto = z.infer<typeof sendTemplateSchema>;

/** Programar un texto: cuál y a qué hora (instante ISO con zona). Que la hora sea futura y caiga dentro de la ventana de 24 h lo decide el servidor. */
export const createScheduledSchema = z.object({ text: text(MAX_MESSAGE_LENGTH), send_at: z.iso.datetime({ offset: true }) }).strict();
export type CreateScheduledDto = z.infer<typeof createScheduledSchema>;

/**
 * Vista global de mensajes programados (M5.10): `scheduled` = los pendientes, de la hora más próxima a la más lejana · `not_sent` = los que no salieron en las últimas 24 h
 * (cancelados o fallidos), los más recientes primero · `sent` = los que ya salieron en las últimas 24 h (v13 S2.3). `mine` deja solo los que programó la persona (útil para quien ve todas las conversaciones).
 */
export const SCHEDULED_VIEWS = ['scheduled', 'not_sent', 'sent'] as const;
export const listScheduledQuerySchema = z
  .object({
    status: z.enum(SCHEDULED_VIEWS).default('scheduled'),
    mine: z.enum(['1', 'true']).transform(() => true).optional(),
    /** v13 S2.3: solo los de un contacto, y solo los que están (o estaban) programados dentro de un rango de fechas (instantes ISO con zona). */
    contact_id: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
export type ListScheduledQuery = z.infer<typeof listScheduledQuerySchema>;

/** Nota interna. `mentions`: las personas nombradas con «@» (F1, ADR-57); el servidor valida cada una (hasta 10, que ya vean la conversación) y avisa a cada quien. */
export const noteSchema = z.object({ text: text(MAX_NOTE_LENGTH), mentions: z.array(z.uuid()).max(50).optional() }).strict();
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
    /** Solo las que ESTA persona destacó con la estrella (v10b, ADR-66; la estrella es personal). */
    favorite: flag.optional(),
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
