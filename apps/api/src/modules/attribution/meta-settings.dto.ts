import { z } from 'zod';

/** Identificador del dataset (pixel): solo dígitos. Se valida también antes de armar la dirección que se llama en Meta. */
const datasetId = z.string().trim().regex(/^[0-9]{5,30}$/, 'el identificador del dataset son solo dígitos');
/** Token de acceso: texto sin espacios; se guarda cifrado y nunca se devuelve. */
const accessToken = z.string().trim().min(20).max(1024).regex(/^\S+$/, 'el token no lleva espacios');
const testEventCode = z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/, 'letras, números, guion y guion bajo (máximo 40)').nullable();

export const saveSettingsSchema = z
  .object({
    dataset_id: datasetId,
    /** Obligatorio la primera vez y al cambiar de dataset; si se omite, se conserva el guardado. */
    access_token: accessToken.optional(),
    /** Ventana de gracia del Purchase en minutos (0 = enviarlo al instante; máximo 24 h). */
    grace_minutes: z.number().int().min(0).max(1440),
    test_event_code: testEventCode.optional(),
    enabled: z.boolean(),
  })
  .strict();
export type SaveSettingsDto = z.infer<typeof saveSettingsSchema>;

export const eventsQuerySchema = z
  .object({
    status: z.enum(['pending', 'sent', 'skipped', 'blocked', 'failed', 'expired', 'cancelled']).optional(),
    type: z.enum(['Lead', 'Schedule', 'Purchase', 'SaleCanceled']).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
export type EventsQuery = z.infer<typeof eventsQuerySchema>;
