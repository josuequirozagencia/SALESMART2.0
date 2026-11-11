import { z } from 'zod';
import { MAX_DELAY_MINUTES, MAX_FIXED_TEXT, MAX_STEPS, MIN_DELAY_MINUTES } from './follow-up-rules';

/**
 * Un paso del seguimiento. Cada paso hace una de estas cosas, o las dos: mandar un mensaje (`ai`: lo escribe la IA; `fixed_text`: un texto con variables, obligatorio) y/o iniciar una automatización
 * de la empresa. Sin ninguna de las dos no tiene sentido y se rechaza.
 */
export const stepSchema = z
  .strictObject({
    delay_minutes: z.number().int().min(MIN_DELAY_MINUTES).max(MAX_DELAY_MINUTES),
    mode: z.enum(['ai', 'fixed_text', 'none']),
    fixed_text: z.string().trim().min(1).max(MAX_FIXED_TEXT).nullable().optional(),
    start_automation_id: z.uuid().nullable().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.mode === 'fixed_text' && !s.fixed_text) ctx.addIssue({ code: 'custom', path: ['fixed_text'], message: 'Escribe el texto del mensaje (o deja que lo escriba la IA)' });
    if (s.mode !== 'fixed_text' && s.fixed_text) ctx.addIssue({ code: 'custom', path: ['fixed_text'], message: 'El texto fijo solo aplica cuando la IA no escribe el mensaje' });
    if (s.mode === 'none' && !s.start_automation_id) ctx.addIssue({ code: 'custom', path: ['mode'], message: 'El paso debe enviar un mensaje o iniciar una automatización' });
  });

/** La secuencia COMPLETA del escenario (reemplaza la anterior). Hasta 5 pasos, en orden. */
export const setFollowUpsSchema = z.strictObject({
  enabled: z.boolean(),
  steps: z.array(stepSchema).max(MAX_STEPS),
});
export type SetFollowUpsDto = z.infer<typeof setFollowUpsSchema>;
export type StepDto = z.infer<typeof stepSchema>;

export interface FollowUpStepView {
  position: number;
  delay_minutes: number;
  mode: 'ai' | 'fixed_text' | 'none';
  fixed_text: string | null;
  start_automation_id: string | null;
}

export interface FollowUpsView {
  scenario: 'stopped_replying';
  enabled: boolean;
  steps: FollowUpStepView[];
  /** Variables que puede llevar un texto fijo. */
  variables: string[];
  /** Automatizaciones activas que un paso puede iniciar. */
  automations: Array<{ id: string; name: string }>;
  /** Lo que pasó en los últimos 7 días (para que la persona vea si funciona). */
  summary: { sent: number; skipped: number; cancelled: number; pending: number; reasons: Record<string, number> };
  updated_at: string | null;
}
