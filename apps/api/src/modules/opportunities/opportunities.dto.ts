import { z } from 'zod';

/** Monto máximo: cabe en numeric(14,2) con margen. */
const MAX_AMOUNT = 999_999_999_999.99;

/**
 * Monto en la moneda de la oportunidad (USD por ahora, ADR-49 #4): número o texto con hasta 2 decimales, ≥ 0. Siempre se guarda y se devuelve como TEXTO con 2
 * decimales («1500.00»): el dinero no pasa por flotantes.
 */
export const moneySchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const text = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'x') : v.trim().replace(',', '.');
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(text) || Number(text) > MAX_AMOUNT) {
      ctx.addIssue({ code: 'custom', message: 'debe ser un monto de 0 a 999999999999.99 con hasta 2 decimales' });
      return z.NEVER;
    }
    return Number(text).toFixed(2);
  });

const noControl = (v: string): boolean => !/\p{Cc}/u.test(v);
const arrayOf = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess((v) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v : [v]), z.array(item).max(max).optional());

export const createOpportunitySchema = z
  .object({
    contact_id: z.uuid(),
    /** Sin pipeline, el primero. */
    pipeline_id: z.uuid().optional(),
    /** Sin etapa, la primera abierta del pipeline. Solo una etapa abierta: para cerrar se usa «mover». */
    stage_id: z.uuid().optional(),
    amount: moneySchema.optional(),
    /** Con `contacts.view_all`: la persona (o null = sin asignar); por defecto, el responsable del contacto. Sin él, siempre uno mismo. */
    owner_id: z.uuid().nullable().optional(),
  })
  .strict();
export type CreateOpportunityDto = z.infer<typeof createOpportunitySchema>;

export const updateOpportunitySchema = z
  .object({ amount: moneySchema.optional(), owner_id: z.uuid().nullable().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateOpportunityDto = z.infer<typeof updateOpportunitySchema>;

/** Mover a una etapa. Mover a la etapa «perdida» exige el motivo (1 a 200 caracteres); en cualquier otra se ignora. */
export const moveOpportunitySchema = z
  .object({ stage_id: z.uuid(), lost_reason: z.string().trim().min(1).max(200).refine(noControl, 'caracteres no permitidos').optional() })
  .strict();
export type MoveOpportunityDto = z.infer<typeof moveOpportunitySchema>;

/** Filtros del tablero (ADR-49 #7), los mismos para listar y para el resumen por etapa. */
export const opportunityFiltersShape = {
  contact: z.uuid().optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  /** Texto en el nombre, el correo o el teléfono del contacto. */
  q: z.string().trim().min(1).max(100).optional(),
  /** `me`, `none` (sin asignar) o el id de una persona (solo con `contacts.view_all`: sin él el alcance ya es propio). */
  owner: z.union([z.literal('me'), z.literal('none'), z.uuid()]).optional(),
  /** Origen del contacto. */
  source: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/).optional(),
  /** El contacto debe tener TODAS estas etiquetas. */
  tag: arrayOf(z.uuid(), 10),
  /** Valor mínimo. */
  min: z.coerce.number().min(0).max(999_999_999_999.99).optional(),
};

export const listOpportunitiesQuerySchema = z
  .object({
    pipeline: z.uuid().optional(),
    stage: z.uuid().optional(),
    ...opportunityFiltersShape,
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ListOpportunitiesQuery = z.infer<typeof listOpportunitiesQuerySchema>;

export const summaryQuerySchema = z.object({ ...opportunityFiltersShape }).strict();
export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
