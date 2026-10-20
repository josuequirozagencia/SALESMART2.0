import { z } from 'zod';

/** Tope provisional de colas por empresa (M5.3). Los límites por plan llegan con la pasarela de pago. */
export const MAX_QUEUES = 20;
/** Tope de asesores configurables por cola. */
export const MAX_QUEUE_MEMBERS = 200;
export const MAX_SIMULATION = 100;

const name = z.string().trim().min(1).max(60).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');
const color = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'color en formato #RRGGBB').transform((v) => v.toLowerCase());
const mode = z.enum(['equal', 'weighted', 'load']);
const batch = z.number().int().min(1).max(50);
const dailyCap = z.number().int().min(0).max(1000);
/** Largo máximo de un mensaje automático de la cola (WhatsApp admite 4096; un saludo largo no se lee). */
export const MAX_AUTO_MESSAGE = 1000;
/** Texto plano que sale al cliente: sin espacios al borde ni caracteres de control (salvo saltos de línea); vacío = no se envía (null). */
const autoText = z
  .string()
  .max(MAX_AUTO_MESSAGE * 2)
  .transform((v) => v.replace(/\r\n?/g, '\n').trim())
  .refine((v) => v.length <= MAX_AUTO_MESSAGE, `usa como máximo ${MAX_AUTO_MESSAGE} caracteres`)
  .refine((v) => !/\p{Cc}/u.test(v.replace(/[\n\t]/g, '')), 'caracteres no permitidos')
  .transform((v) => (v === '' ? null : v))
  .nullable();

export const createQueueSchema = z.object({ name, color: color.optional() }).strict();
export type CreateQueueDto = z.infer<typeof createQueueSchema>;

export const updateQueueSchema = z
  .object({ name: name.optional(), color: color.optional(), distribution_on: z.boolean().optional(), mode: mode.optional(), batch: batch.optional(), daily_cap: dailyCap.optional(), only_unassigned: z.boolean().optional(), respect_hours: z.boolean().optional(), reassign_minutes: z.number().int().min(0).max(1440).optional(), max_rotations: z.number().int().min(1).max(10).optional(), greeting: autoText.optional(), out_of_hours_message: autoText.optional(), auto_close_hours: z.number().int().min(0).max(720).optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateQueueDto = z.infer<typeof updateQueueSchema>;

const member = z.object({ user_id: z.uuid(), active: z.boolean(), weight: z.number().int().min(1).max(100) }).strict();
const members = z
  .array(member)
  .max(MAX_QUEUE_MEMBERS)
  .refine((l) => new Set(l.map((m) => m.user_id)).size === l.length, 'una persona aparece más de una vez');

/** Reemplaza la configuración de los asesores de la cola: quien aparece queda como se indica; quien tenía fila y no aparece, se apaga. */
export const setMembersSchema = z.object({ members }).strict();
export type SetMembersDto = z.infer<typeof setMembersSchema>;
export type MemberInput = z.infer<typeof member>;

/** Simulación sin guardar nada: por omisión usa lo guardado; cualquier campo que se mande lo sustituye (sirve para probar antes de guardar). */
export const simulateSchema = z.object({ count: z.number().int().min(1).max(MAX_SIMULATION).optional(), mode: mode.optional(), batch: batch.optional(), daily_cap: dailyCap.optional(), members: members.optional() }).strict();
export type SimulateDto = z.infer<typeof simulateSchema>;
