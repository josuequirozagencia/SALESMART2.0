import { z } from 'zod';

export const requestExtensionSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
export type RequestExtensionDto = z.infer<typeof requestExtensionSchema>;

export const trialIdParamSchema = z.uuid();

export const listTrialsQuerySchema = z
  .object({
    extension: z.enum(['none', 'pending', 'approved', 'denied']).optional(),
    state: z.enum(['active', 'expired']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.uuid().optional(),
  })
  .strict();
export type ListTrialsQuery = z.infer<typeof listTrialsQuerySchema>;
