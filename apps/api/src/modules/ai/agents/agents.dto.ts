import { z } from 'zod';
import { COVERS } from './agent-prompt';

const modelKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
const text = (max: number) => z.string().max(max);

export const createAgentSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(120).nullable().optional(),
  cover: z.enum(COVERS).optional(),
  model: modelKey.optional(),
});
export type CreateAgentDto = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(60),
    role: z.string().trim().max(120).nullable(),
    cover: z.enum(COVERS),
    active: z.boolean(),
    model: modelKey,
    temperature: z.number().min(0).max(1.5),
    max_tokens: z.number().int().min(100).max(2000),
    max_chars: z.number().int().min(100).max(4000),
    personality: text(4000),
    objective: text(4000),
    extra_info: text(8000),
    show_source: z.boolean(),
    split_enabled: z.boolean(),
    split_blocks: z.number().int().min(1).max(5),
    transfer_enabled: z.boolean(),
    transfer_queue_id: z.uuid().nullable(),
    always_on: z.boolean(),
    /** Variables de campos personalizados del contacto que el agente puede rellenar (M8.5b); [] = ninguno. */
    capture_fields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).max(10),
    tasks_enabled: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'No hay nada que cambiar');
export type UpdateAgentDto = z.infer<typeof updateAgentSchema>;

export const setDocumentsSchema = z.strictObject({ document_ids: z.array(z.uuid()).max(200) });
export type SetDocumentsDto = z.infer<typeof setDocumentsSchema>;

export const setChannelsSchema = z.strictObject({ channel_ids: z.array(z.uuid()).max(20) });
export type SetChannelsDto = z.infer<typeof setChannelsSchema>;

export const previewSchema = z.strictObject({
  agent_id: z.uuid().optional(),
  name: z.string().trim().min(1).max(60).optional(),
  role: z.string().trim().max(120).nullable().optional(),
  personality: text(4000).optional(),
  objective: text(4000).optional(),
  extra_info: text(8000).optional(),
  show_source: z.boolean().optional(),
  max_chars: z.number().int().min(100).max(4000).optional(),
  /** Un contacto real para llenar las variables; sin él se usa un ejemplo. */
  contact_id: z.uuid().nullable().optional(),
});
export type PreviewDto = z.infer<typeof previewSchema>;

export const testTurnSchema = z.strictObject({
  message: z.string().trim().min(1).max(1000),
  /** Los turnos anteriores de la conversación de prueba (los lleva la pantalla; el servidor solo usa los más recientes). */
  history: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(2000) })).max(30).optional(),
  /** «Probar como» este contacto: solo se lee para llenar las variables. */
  contact_id: z.uuid().nullable().optional(),
});
export type TestTurnDto = z.infer<typeof testTurnSchema>;
