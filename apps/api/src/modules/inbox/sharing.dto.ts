import { z } from 'zod';

/** Tope provisional de colaboradores vigentes por conversación (M5.5). */
export const MAX_PARTICIPANTS = 10;
/** Largo máximo de la nota que acompaña a un traspaso. */
export const MAX_HANDOFF_NOTE = 500;

const permission = z.enum(['reply', 'view']);

/** Nota opcional del traspaso: sin espacios al borde y sin caracteres de control (salvo salto de línea y tabulación); vacía = sin nota. */
const note = z
  .string()
  .trim()
  .max(MAX_HANDOFF_NOTE)
  .refine((v) => !/\p{Cc}/u.test(v.replace(/[\n\r\t]/g, '')), 'caracteres no permitidos')
  .transform((v) => (v === '' ? undefined : v))
  .optional();

/** Transferir: pasa la conversación (y el lead) a otra persona. `keep_as` deja a quien la tenía como colaborador con ese permiso. */
export const transferSchema = z.object({ to_user_id: z.uuid(), keep_as: permission.nullish(), note }).strict();
export type TransferDto = z.infer<typeof transferSchema>;

/** Compartir: da acceso a otra persona SIN cambiar el dueño. Repetirlo con otro permiso cambia el permiso. */
export const shareSchema = z.object({ user_id: z.uuid(), permission, note }).strict();
export type ShareDto = z.infer<typeof shareSchema>;
