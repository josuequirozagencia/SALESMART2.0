import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/\p{Cc}/u.test(v.replace(/[\n\t]/g, '')), 'caracteres no permitidos');

/** `Idempotency-Key` de la petición: repetirla devuelve la misma cita (doble clic, reintento de red). */
export const idempotencyKeySchema = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/, 'solo letras, números y _ . : -');

/** Instante con zona (ISO 8601 con offset o Z): la hora local de la empresa la convierte la interfaz. */
const instant = z.iso.datetime({ offset: true });
/** «N minutos antes»: de 1 minuto a 30 días. */
const offsets = z.array(z.number().int().min(1).max(43_200)).max(5).refine((l) => new Set(l).size === l.length, 'un mismo «minutos antes» no puede repetirse');
const params = z.record(z.string().max(100), z.string().max(1024)).refine((o) => Object.keys(o).length <= 20, 'demasiados valores');

export const createAppointmentSchema = z
  .object({
    conversation_id: z.uuid(),
    starts_at: instant,
    duration_minutes: z.number().int().min(5).max(1440).optional(),
    kind: text(60).optional(),
    notes: text(1000).optional(),
    /** Recordatorios: minutos antes de la cita. */
    reminders: offsets.optional(),
    /** Plantilla aprobada (y sus valores) para los recordatorios que caigan fuera de la ventana de 24 h. */
    reminder_template_id: z.uuid().optional(),
    reminder_params: params.optional(),
  })
  .strict();
export type CreateAppointmentDto = z.infer<typeof createAppointmentSchema>;

export const updateAppointmentSchema = z
  .object({
    starts_at: instant.optional(),
    duration_minutes: z.number().int().min(5).max(1440).optional(),
    kind: text(60).optional(),
    notes: text(1000).nullable().optional(),
    reminders: offsets.optional(),
    reminder_template_id: z.uuid().nullable().optional(),
    reminder_params: params.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateAppointmentDto = z.infer<typeof updateAppointmentSchema>;

export const cancelAppointmentSchema = z.object({ reason: text(500) }).strict();
export type CancelAppointmentDto = z.infer<typeof cancelAppointmentSchema>;

/** Máximo de días que abarca una consulta de agenda. */
export const MAX_AGENDA_DAYS = 62;
export const listAppointmentsQuerySchema = z
  .object({
    from: instant.optional(),
    to: instant.optional(),
    owner_id: z.uuid().optional(),
    status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
    contact_id: z.uuid().optional(),
  })
  .strict();
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;

export const optionsQuerySchema = z.object({ conversation_id: z.uuid() }).strict();
export type OptionsQuery = z.infer<typeof optionsQuerySchema>;
