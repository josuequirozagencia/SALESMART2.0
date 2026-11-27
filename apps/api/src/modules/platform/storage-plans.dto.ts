import { z } from 'zod';

const GB = 1024 ** 3;
const money = z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/, 'Un importe como 8 o 8.50');

export const planSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  /** El espacio que suma, en GB (acepta decimales); se guarda en bytes. */
  extra_gb: z.number().positive().max(10_240),
  price_amount: money,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Tres letras, como USD').default('USD'),
  active: z.boolean().default(true),
  sort: z.number().int().min(0).max(1000).default(0),
});
export type PlanDto = z.infer<typeof planSchema>;
export const planUpdateSchema = planSchema.partial();
export type PlanUpdateDto = z.infer<typeof planUpdateSchema>;

export const requestSchema = z.strictObject({ plan_id: z.uuid().optional(), note: z.string().trim().max(300).optional() });
export type RequestDto = z.infer<typeof requestSchema>;

export const grantSchema = z
  .strictObject({
    /** Un plan del catálogo (copia su nombre, espacio y precio) o, sin plan, un regalo: espacio y motivo propios. */
    plan_id: z.uuid().optional(),
    extra_gb: z.number().positive().max(10_240).optional(),
    starts_at: z.iso.datetime({ offset: true }).optional(),
    ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.plan_id === undefined && b.extra_gb === undefined) ctx.addIssue({ code: 'custom', path: ['plan_id'], message: 'Elige un plan o escribe cuánto espacio dar' });
    if (b.plan_id === undefined && !b.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Sin plan, el motivo es obligatorio' });
    if (b.plan_id !== undefined && b.extra_gb !== undefined) ctx.addIssue({ code: 'custom', path: ['extra_gb'], message: 'Con un plan, el espacio sale del plan' });
    if (b.starts_at && b.ends_at && new Date(b.ends_at) <= new Date(b.starts_at)) ctx.addIssue({ code: 'custom', path: ['ends_at'], message: 'El fin debe ser posterior al inicio' });
  });
export type GrantDto = z.infer<typeof grantSchema>;

export const revokeSchema = z.strictObject({ reason: z.string().trim().min(3).max(300) });
export type RevokeDto = z.infer<typeof revokeSchema>;

export const toBytes = (gb: number): number => Math.round(gb * GB);

export interface PlanView {
  id: string;
  name: string;
  extra_bytes: number;
  price_amount: string;
  currency: string;
  period: 'monthly';
  active: boolean;
  sort: number;
}
/** Lo que ve un cliente de un plan: solo el precio de lista. */
export type PublicPlanView = Pick<PlanView, 'id' | 'name' | 'extra_bytes' | 'price_amount' | 'currency' | 'period'>;

export interface GrantView {
  id: string;
  kind: 'grant' | 'revoke';
  plan_name: string;
  extra_bytes: number;
  price_amount: string | null;
  currency: string | null;
  starts_at: string;
  ends_at: string | null;
  revokes_grant_id: string | null;
  origin: 'manual' | 'payment';
  reason: string | null;
  created_at: string;
  /** Vigente ahora y no anulada. */
  active: boolean;
  revoked: boolean;
}
export interface RequestView {
  id: string;
  plan_id: string | null;
  plan_name: string | null;
  status: 'open' | 'granted' | 'dismissed';
  note: string | null;
  created_at: string;
}
