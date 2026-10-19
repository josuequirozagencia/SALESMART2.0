import { z } from 'zod';

/** Tope provisional de feriados vigentes por empresa. */
export const MAX_HOLIDAYS = 200;

export const policySchema = z
  .object({
    /** Minutos de tiempo abierto para responder (el SLA). */
    target_minutes: z.number().int().min(1).max(1440),
    /** Cuántos minutos antes de vencer se marca «en riesgo». */
    risk_minutes: z.number().int().min(0).max(1440),
  })
  .strict()
  .refine((b) => b.risk_minutes <= b.target_minutes, { path: ['risk_minutes'], message: 'El aviso de riesgo no puede ser mayor que el objetivo' });
export type PolicyDto = z.infer<typeof policySchema>;

const interval = z.tuple([z.string().max(5), z.string().max(5)]);
const day = z.array(interval).max(3);
/** Un horario semanal: por día, sus tramos «HH:MM»–«HH:MM». Un día sin tramos está cerrado. */
export const weekSchema = z.object({ mon: day.optional(), tue: day.optional(), wed: day.optional(), thu: day.optional(), fri: day.optional(), sat: day.optional(), sun: day.optional() }).strict();

/** `days: null` quita el horario: la empresa vuelve a estar abierta siempre; el de una cola, a usar el de la empresa. */
export const hoursSchema = z.object({ days: weekSchema.nullable() }).strict();
export type HoursDto = z.infer<typeof hoursSchema>;

const noControl = (v: string): boolean => !/\p{Cc}/u.test(v);

export const holidaySchema = z
  .object({
    /** AAAA-MM-DD. */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Usa el formato AAAA-MM-DD')
      .refine((v) => {
        const [y, m, d] = v.split('-').map(Number) as [number, number, number];
        const t = new Date(Date.UTC(y, m - 1, d));
        return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 2000 && y <= 2100;
      }, 'Esa fecha no existe'),
    name: z.string().trim().min(1).max(80).refine(noControl, 'caracteres no permitidos'),
    /** Se repite cada año (mismo día y mes). */
    yearly: z.boolean().default(false),
  })
  .strict();
export type HolidayDto = z.infer<typeof holidaySchema>;
