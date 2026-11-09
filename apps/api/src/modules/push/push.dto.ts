import { z } from 'zod';
import { MAX_ENDPOINT_CHARS } from './push-endpoint';

const key = z.string().min(10).max(200).regex(/^[A-Za-z0-9_-]+={0,2}$/, 'clave en base64url');

/** La suscripción que entrega el navegador (`PushSubscription.toJSON()`), más si la notificación lleva el texto del mensaje. */
export const subscribeSchema = z
  .object({
    endpoint: z.string().min(10).max(MAX_ENDPOINT_CHARS),
    keys: z.object({ p256dh: key, auth: key }).strict(),
    show_text: z.boolean().default(false),
  })
  .strict();
export type SubscribeInput = z.infer<typeof subscribeSchema>;

/** Identifica el navegador por su dirección de suscripción (va en el cuerpo, no en la URL, para que no quede en los registros). */
export const endpointSchema = z.object({ endpoint: z.string().min(10).max(MAX_ENDPOINT_CHARS) }).strict();
export type EndpointInput = z.infer<typeof endpointSchema>;
