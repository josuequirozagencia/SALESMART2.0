import { z } from 'zod';

/** Location (subcuenta) de GHL: solo letras y números. Se valida también antes de armar la dirección que se llama en GHL. */
const locationId = z.string().trim().regex(/^[A-Za-z0-9]{8,64}$/, 'el Location ID son solo letras y números');
/** Token de integración privada: texto sin espacios; se guarda cifrado y nunca se devuelve. */
const accessToken = z.string().trim().min(20).max(1024).regex(/^\S+$/, 'el token no lleva espacios');

export const saveConnectionSchema = z
  .object({
    location_id: locationId,
    /** Obligatorio la primera vez, al cambiar de Location y tras un rechazo o una desconexión; si se omite, se conserva el guardado. */
    access_token: accessToken.optional(),
  })
  .strict();
export type SaveConnectionDto = z.infer<typeof saveConnectionSchema>;

export const eventsQuerySchema = z
  .object({
    status: z.enum(['pending', 'done', 'skipped', 'failed']).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
export type EventsQuery = z.infer<typeof eventsQuerySchema>;

export const outboxQuerySchema = eventsQuerySchema;
export type OutboxQuery = EventsQuery;

/** Canal «GoHighLevel» del Inbox (M7.4): a qué cola van las conversaciones nuevas y por qué canal de GHL se responde cuando el aviso no lo dice. */
export const channelConfigSchema = z
  .object({
    queue_id: z.uuid().nullable(),
    default_type: z.enum(['SMS', 'WhatsApp', 'IG', 'FB', 'Live_Chat']).nullable(),
  })
  .strict();
export type ChannelConfigDto = z.infer<typeof channelConfigSchema>;
