import { z } from 'zod';
import { MAX_DELAY_MINUTES, MAX_FILES_PER_STEP, MAX_FIXED_TEXT, MAX_STEPS, MIN_DELAY_MINUTES } from './follow-up-rules';

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
    /** Archivos (ya subidos) que lleva el paso, en orden: hasta 3 y solo con texto fijo (v15). */
    file_ids: z.array(z.uuid()).max(MAX_FILES_PER_STEP).optional(),
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

/** Un archivo de un paso (v15): nunca la clave del almacenamiento. */
export interface FollowUpFileView {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  mime_type: string;
  filename: string;
  size_bytes: number;
  /** `clean` (el antivirus lo revisó) o `skipped` (no hay antivirus configurado: el archivo NO se revisó). */
  scan_status: 'clean' | 'skipped';
  step_position: number | null;
  sort_order: number;
}

export interface FollowUpStepView {
  position: number;
  delay_minutes: number;
  mode: 'ai' | 'fixed_text' | 'none';
  fixed_text: string | null;
  start_automation_id: string | null;
  files: FollowUpFileView[];
}

export interface FollowUpsView {
  scenario: 'stopped_replying';
  enabled: boolean;
  steps: FollowUpStepView[];
  /** Archivos subidos que aún no están en ningún paso (esperan a guardar; vencen a las 24 h). */
  loose_files: FollowUpFileView[];
  /** Lo que ocupan los archivos de los seguimientos de este agente y lo que admite cada tipo. `available`: hay dónde guardar archivos. */
  files_storage: { files: number; bytes: number; available: boolean; limits: { max_per_step: number; max_mb: Record<'image' | 'video' | 'audio' | 'document', number> } };
  /** Qué tipos de conexión atiende el agente: oficial (ventana de 24 h), QR (sin ventana) y GoHighLevel (solo texto). */
  channels: { official: boolean; qr: boolean; ghl: boolean };
  /** Variables que puede llevar un texto fijo. */
  variables: string[];
  /** Automatizaciones activas que un paso puede iniciar. */
  automations: Array<{ id: string; name: string }>;
  /** Lo que pasó en los últimos 7 días (para que la persona vea si funciona). */
  summary: { sent: number; skipped: number; cancelled: number; pending: number; reasons: Record<string, number> };
  updated_at: string | null;
}
