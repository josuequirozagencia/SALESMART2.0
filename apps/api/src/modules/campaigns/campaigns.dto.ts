import { z } from 'zod';
import { CAMPAIGN_STATUSES } from '../../db';
import { contactFiltersSchema } from '../contacts';

/** Pausa mínima entre mensajes (s): 45 por QR (ADR-72 #4) y 5 por WhatsApp oficial (el prototipo). */
export const MIN_GAP_QR_S = 45;
export const MIN_GAP_OFFICIAL_S = 5;
/** Tope diario por empresa de WhatsApp oficial (PROVISIONAL, ADR-72 #5: el de verdad —por empresa— se guarda y aplica en 17.3). */
export const OFFICIAL_DAILY_CAP = 1000;
/** La campaña por QR usa como máximo este porcentaje del cupo diario del calentamiento (ADR-72 #4; PROVISIONAL). */
export const QR_CAMPAIGN_SHARE = 0.7;
/** Más contactos que esto en una sola campaña es un 400 (PROVISIONAL). */
export const MAX_AUDIENCE = 5000;
export const MAX_EXCLUDED = 5000;
export const MAX_DRAFTS_PER_USER = 100;

export const idempotencyKeySchema = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/, 'solo letras, números y _ . : -');

/**
 * De dónde salen los destinatarios (como las «bases» del prototipo): toda la base visible, una lista guardada (fija o dinámica) o filtros sueltos. `excluded_contact_ids` son los que quien
 * crea la campaña desmarcó a mano. El alcance de la persona manda siempre: un asesor solo llega a sus contactos aunque la lista sea de la empresa.
 */
export const audienceSchema = z
  .object({
    source: z.enum(['all', 'list', 'filters']),
    list_id: z.uuid().optional(),
    filters: contactFiltersSchema.optional(),
    excluded_contact_ids: z.array(z.uuid()).max(MAX_EXCLUDED).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.source === 'list' && !a.list_id) ctx.addIssue({ code: 'custom', path: ['list_id'], message: 'Elige la lista' });
    if (a.source !== 'list' && a.list_id) ctx.addIssue({ code: 'custom', path: ['list_id'], message: 'Solo va con la base «lista»' });
    if (a.source !== 'filters' && a.filters) ctx.addIssue({ code: 'custom', path: ['filters'], message: 'Solo va con la base «filtros»' });
  });
export type AudienceDto = z.infer<typeof audienceSchema>;

const paramsSchema = z.record(z.string().regex(/^(?:(?:header|body):[A-Za-z0-9_]+|button:\d+:[A-Za-z0-9_]+)$/).max(60), z.string().trim().min(1).max(500)).refine((o) => Object.keys(o).length <= 20, 'Demasiadas variables');

const fields = {
  name: z.string().trim().min(1).max(80),
  channel_id: z.uuid(),
  mode: z.enum(['template', 'text']),
  template_id: z.uuid().nullable().optional(),
  template_params: paramsSchema.optional(),
  body: z.string().trim().min(1).max(1000).nullable().optional(),
  audience: audienceSchema,
  include_unknown_consent: z.boolean().optional(),
  scheduled_at: z.iso.datetime({ offset: true }).nullable().optional(),
  gap_seconds: z.number().int().min(5).max(3600),
  daily_cap: z.number().int().min(1).max(10000),
};

export const createCampaignSchema = z.object(fields).strict();
export type CreateCampaignDto = z.infer<typeof createCampaignSchema>;

/** Editar un borrador: cualquier campo; el servidor junta lo guardado con lo nuevo y vuelve a validar el conjunto. */
export const updateCampaignSchema = z.object(fields).partial().strict().refine((o) => Object.keys(o).length > 0, 'No hay nada que cambiar');
export type UpdateCampaignDto = z.infer<typeof updateCampaignSchema>;

export const listCampaignsQuerySchema = z
  .object({
    status: z.enum(CAMPAIGN_STATUSES).optional(),
    mine: z.preprocess((v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v), z.boolean().optional()),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;

export const advisorLimitSchema = z.object({ daily_cap: z.number().int().min(1).max(10000) }).strict();
export type AdvisorLimitDto = z.infer<typeof advisorLimitSchema>;
