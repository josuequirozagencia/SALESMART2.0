import { z } from 'zod';
import { PLAN_FEATURE_KEYS } from './plan-features';

const limit = z.number().int().min(1).max(100_000).nullable();
const name = z.string().trim().min(2).max(60).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');
const description = z.string().trim().max(200).nullable();
/** Solo las claves del catálogo; cualquier otra se rechaza (no se guarda basura en el plan). */
const features = z.object(Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, z.boolean().optional()]))).strict();

export const createPlanSchema = z
  .object({ name, description: description.optional(), max_users: limit.optional(), max_connections: limit.optional(), max_queues: limit.optional(), features: features.optional() })
  .strict();
export type CreatePlanDto = z.infer<typeof createPlanSchema>;

export const updatePlanSchema = z
  .object({ name: name.optional(), description: description.optional(), max_users: limit.optional(), max_connections: limit.optional(), max_queues: limit.optional(), features: features.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'no hay nada que cambiar');
export type UpdatePlanDto = z.infer<typeof updatePlanSchema>;

export const listPlansQuerySchema = z.object({ include_archived: z.enum(['true', 'false']).default('false') }).strict();
export type ListPlansQuery = z.infer<typeof listPlansQuerySchema>;

export const uuidParam = z.uuid();

export const listCompaniesQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    kind: z.enum(['client', 'agency']).optional(),
    state: z.enum(['trial', 'trial_expired', 'active', 'suspended', 'invited']).optional(),
    /** Un id de plan o «none» (empresas sin plan). */
    plan: z.union([z.uuid(), z.literal('none')]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.uuid().optional(),
  })
  .strict();
export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;

export const assignPlanSchema = z.object({ plan_id: z.uuid().nullable() }).strict();
export type AssignPlanDto = z.infer<typeof assignPlanSchema>;
