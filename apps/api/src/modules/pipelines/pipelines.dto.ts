import { z } from 'zod';

/** Topes provisionales (ADR-49). */
export const MAX_PIPELINES = 10;
export const MAX_STAGES = 15;

/** Paleta de 8 pasteles: la web pinta el encabezado de la columna con el color de cada clave. */
export const STAGE_COLORS = ['blue', 'teal', 'violet', 'amber', 'green', 'red', 'pink', 'gray'] as const;
export type StageColor = (typeof STAGE_COLORS)[number];
export type StageKind = 'open' | 'won' | 'lost';

const noControl = (v: string): boolean => !/\p{Cc}/u.test(v);
const pipelineName = z.string().trim().min(1).max(60).refine(noControl, 'caracteres no permitidos');
const stageName = z.string().trim().min(1).max(40).refine(noControl, 'caracteres no permitidos');
const color = z.enum(STAGE_COLORS);
const ids = z.array(z.uuid()).min(1).max(100).refine((a) => new Set(a).size === a.length, 'hay ids repetidos');

/** Etapa de un pipeline nuevo. Si no se envían etapas, el pipeline nace con «Nuevo», «En seguimiento» y «Ganado». */
const newStage = z.object({ name: stageName, kind: z.enum(['open', 'won', 'lost']).default('open'), color: color.optional() }).strict();

export const createPipelineSchema = z
  .object({ name: pipelineName, stages: z.array(newStage).min(2).max(MAX_STAGES).optional() })
  .strict()
  .superRefine((b, ctx) => {
    if (!b.stages) return;
    const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['stages'], message });
    if (b.stages.filter((s) => s.kind === 'won').length !== 1) issue('debe haber exactamente una etapa ganada');
    if (b.stages.filter((s) => s.kind === 'lost').length > 1) issue('solo puede haber una etapa perdida');
    if (!b.stages.some((s) => s.kind === 'open')) issue('debe haber al menos una etapa abierta');
    if (new Set(b.stages.map((s) => s.name.toLowerCase())).size !== b.stages.length) issue('hay nombres de etapa repetidos');
  });
export type CreatePipelineDto = z.infer<typeof createPipelineSchema>;

export const updatePipelineSchema = z
  .object({ name: pipelineName.optional(), appointment_stage_id: z.uuid().nullable().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdatePipelineDto = z.infer<typeof updatePipelineSchema>;

export const orderSchema = z.object({ ids }).strict();
export type OrderDto = z.infer<typeof orderSchema>;

/** Etapa nueva: abierta o perdida (la ganada se marca sobre una existente). Sin posición, va justo antes de la ganada. */
export const createStageSchema = z.object({ name: stageName, color: color.optional(), kind: z.enum(['open', 'lost']).default('open') }).strict();
export type CreateStageDto = z.infer<typeof createStageSchema>;

export const updateStageSchema = z
  .object({ name: stageName.optional(), color: color.optional(), is_hidden: z.boolean().optional(), kind: z.enum(['open', 'won', 'lost']).optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateStageDto = z.infer<typeof updateStageSchema>;
