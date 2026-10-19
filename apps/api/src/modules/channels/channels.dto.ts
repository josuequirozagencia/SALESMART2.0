import { z } from 'zod';

/** Tope provisional de conexiones por empresa (ADR-50). */
export const MAX_CHANNELS = 10;

const name = z.string().trim().min(1).max(60).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');
const metaId = z.string().trim().regex(/^[0-9]{5,25}$/, 'debe tener solo dígitos (5 a 25)');
/** Token de acceso: ASCII imprimible sin espacios (va en una cabecera). */
const token = z.string().trim().regex(/^[\x21-\x7E]{10,1000}$/, 'el token tiene un formato no válido');

/** Conexión nueva de WhatsApp oficial: el número y su token. Se comprueba contra el proveedor antes de guardarla. */
/** Cola por defecto de la conexión (M5.3): `null` o ausente = sin cola (las conversaciones nuevas quedan «sin asignar»). */
const queueId = z.uuid().nullable();

export const createChannelSchema = z.object({ name, waba_id: metaId, phone_number_id: metaId, access_token: token, queue_id: queueId.optional() }).strict();
export type CreateChannelDto = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = z
  .object({ name: name.optional(), status: z.enum(['active', 'disabled']).optional(), access_token: token.optional(), queue_id: queueId.optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateChannelDto = z.infer<typeof updateChannelSchema>;
