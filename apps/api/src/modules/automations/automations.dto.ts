import { z } from 'zod';
import { actionSchema, conditionSchema, MAX_ACTIONS, MAX_CONDITIONS, triggerSchema } from './automation-model';

const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(300).nullable();

export const createAutomationSchema = z.strictObject({
  name,
  description: description.optional(),
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).max(MAX_CONDITIONS).default([]),
  actions: z.array(actionSchema).max(MAX_ACTIONS).default([]),
});
export type CreateAutomationDto = z.infer<typeof createAutomationSchema>;

export const updateAutomationSchema = z
  .strictObject({
    name,
    description,
    trigger: triggerSchema,
    conditions: z.array(conditionSchema).max(MAX_CONDITIONS),
    actions: z.array(actionSchema).max(MAX_ACTIONS),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'No hay nada que cambiar');
export type UpdateAutomationDto = z.infer<typeof updateAutomationSchema>;

export const runsQuerySchema = z.object({
  status: z.enum(['queued', 'waiting', 'done', 'skipped', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
export type RunsQuery = z.infer<typeof runsQuerySchema>;

export const testAutomationSchema = z.strictObject({ contact_id: z.uuid() });
export type TestAutomationDto = z.infer<typeof testAutomationSchema>;
