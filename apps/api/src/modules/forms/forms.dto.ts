import { z } from 'zod';
import { FIELD_KINDS, MAX_DOMAINS, MAX_FIELDS, MAX_OPTIONS } from './form-model';

const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(300).nullable();

export const createFormSchema = z.strictObject({ name, description: description.optional() });
export type CreateFormDto = z.infer<typeof createFormSchema>;

export const updateFormSchema = z
  .strictObject({
    name,
    description,
    queue_id: z.uuid().nullable(),
    pipeline_id: z.uuid().nullable(),
    stage_id: z.uuid().nullable(),
    extra_tag_id: z.uuid().nullable(),
    consent_text: z.string().trim().min(10).max(500),
    thanks_message: z.string().trim().min(1).max(300),
    redirect_url: z.string().trim().max(500).nullable(),
    allowed_domains: z.array(z.string().trim().max(255)).max(MAX_DOMAINS),
    phone_prefix: z.string().regex(/^\+[1-9][0-9]{0,3}$/),
    /** Seguimiento (M9.2): tarea para el responsable y, opcionalmente, una plantilla de WhatsApp (conexión y plantilla juntas o ninguna). */
    follow_up_task: z.boolean(),
    follow_up_channel_id: z.uuid().nullable(),
    follow_up_template_id: z.uuid().nullable(),
    /** Valores de las variables de la plantilla, por su clave (`body:1`, `body:nombre`, `header:1`, `button:0:1`). */
    follow_up_params: z.record(z.string().regex(/^(?:(?:header|body):[A-Za-z0-9_]{1,30}|button:\d{1,2}:[A-Za-z0-9_]{1,30})$/), z.string().max(200)).refine((r) => Object.keys(r).length <= 10, 'Demasiadas variables'),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'No hay nada que cambiar');
export type UpdateFormDto = z.infer<typeof updateFormSchema>;

const fieldSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).optional(),
  kind: z.enum(FIELD_KINDS),
  label: z.string().trim().min(1).max(100),
  maps_to: z.string().regex(/^(name|phone|email|note|custom:[a-z][a-z0-9_]{0,39})$/),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(100)).max(MAX_OPTIONS).nullable().optional(),
  placeholder: z.string().trim().max(100).nullable().optional(),
});
export const setFieldsSchema = z.strictObject({ fields: z.array(fieldSchema).min(1).max(MAX_FIELDS) });
export type SetFieldsDto = z.infer<typeof setFieldsSchema>;

export const submissionsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(200).optional() });
export type SubmissionsQuery = z.infer<typeof submissionsQuerySchema>;

/** Lo que manda la página con el formulario (público): los valores por clave de campo, el consentimiento, el captcha y los datos de seguimiento. Estricto: lo que no se conoce se rechaza. */
export const publicSubmitSchema = z.strictObject({
  values: z.record(z.string().max(40), z.union([z.string().max(2500), z.number()])),
  consent: z.boolean(),
  captcha_token: z.string().max(4096).optional(),
  /** Campo trampa: las personas no lo ven ni lo llenan. */
  hp: z.string().max(200).optional(),
  /** El mismo identificador que el Pixel de la página usa en su evento Lead (para deduplicar). */
  event_id: z.string().regex(/^[A-Za-z0-9_.:-]{8,64}$/).optional(),
  source_url: z.string().max(500).optional(),
  utm: z.record(z.string().max(40), z.string().max(200)).optional(),
  fbc: z.string().max(200).optional(),
  fbp: z.string().max(200).optional(),
});
export type PublicSubmitDto = z.infer<typeof publicSubmitSchema>;
