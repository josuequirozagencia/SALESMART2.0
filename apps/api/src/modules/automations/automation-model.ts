import { z } from 'zod';
import type { DomainEvent, DomainEventType } from '../events';

/**
 * Modelo PURO de las automatizaciones (M9.3, ADR-54; F20): la forma válida de una regla (disparador, condiciones y acciones), si un hecho la dispara y si un contacto cumple sus condiciones.
 * Sin base de datos ni red: el servidor lo usa para validar lo que el editor guarda y para decidir al ejecutar (la interfaz es solo ayuda).
 */
export const MAX_ACTIONS = 10;
export const MAX_CONDITIONS = 10;
export const MAX_AUTOMATIONS = 50;
/** Hasta cuántas reglas pueden encadenarse (una provoca un hecho que dispara otra…). Pasado esto no se encola nada más. */
export const MAX_DEPTH = 5;
/** Ejecuciones de una misma regla sobre un mismo contacto en una hora: frena a una regla que se dispara en cascada sin repetirse en la cadena (p. ej. cada mensaje de una conversación larga). */
export const MAX_RUNS_PER_CONTACT_HOUR = 30;

const uuid = z.uuid();
const varKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

// ---------------------------------------------------------------------------------------------- disparador

const FILTERS = {
  contact_created: z.strictObject({ source: z.string().trim().min(1).max(40).optional() }),
  message_received: z.strictObject({ channel_id: uuid.optional() }),
  opportunity_created: z.strictObject({ pipeline_id: uuid.optional() }),
  stage_changed: z.strictObject({ pipeline_id: uuid.optional(), to_stage_id: uuid.optional(), to_status: z.enum(['open', 'won', 'lost']).optional() }),
  field_changed: z.strictObject({ field: varKey, value: z.string().trim().max(200).optional() }),
  sale_created: z.strictObject({}),
} as const satisfies Record<DomainEventType, z.ZodType>;

export const TRIGGER_LABEL: Record<DomainEventType, string> = {
  contact_created: 'Se crea un contacto',
  message_received: 'Llega un mensaje del cliente',
  opportunity_created: 'Se crea una oportunidad',
  stage_changed: 'Una oportunidad cambia de etapa',
  field_changed: 'Cambia un campo del contacto',
  sale_created: 'Se registra una venta',
};

export const triggerSchema = z
  .strictObject({ type: z.enum(Object.keys(FILTERS) as [DomainEventType, ...DomainEventType[]]), filter: z.record(z.string(), z.unknown()).default({}) })
  .superRefine((t, ctx) => {
    const r = FILTERS[t.type].safeParse(t.filter);
    if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: ['filter', ...i.path], message: i.message });
  });
export type TriggerDef = z.infer<typeof triggerSchema>;

/** ¿Este hecho dispara una regla con este disparador y filtro? */
export function matchesTrigger(type: DomainEventType, filter: Readonly<Record<string, unknown>>, e: DomainEvent): boolean {
  if (e.type !== type) return false;
  switch (e.type) {
    case 'contact_created':
      return filter['source'] === undefined || filter['source'] === e.source;
    case 'message_received':
      return filter['channel_id'] === undefined || filter['channel_id'] === e.channelId;
    case 'opportunity_created':
      return filter['pipeline_id'] === undefined || filter['pipeline_id'] === e.pipelineId;
    case 'stage_changed':
      return (filter['pipeline_id'] === undefined || filter['pipeline_id'] === e.pipelineId) && (filter['to_stage_id'] === undefined || filter['to_stage_id'] === e.toStageId) && (filter['to_status'] === undefined || filter['to_status'] === e.status);
    case 'field_changed':
      return filter['field'] === e.field && (filter['value'] === undefined || String(filter['value']).trim().toLowerCase() === (e.newValue ?? '').trim().toLowerCase());
    case 'sale_created':
      return true;
  }
}

/** Lo mínimo del hecho que se guarda en la ejecución (los ids que las acciones o las condiciones puedan necesitar); nunca texto de mensajes. */
export function contextOf(e: DomainEvent): Record<string, unknown> {
  switch (e.type) {
    case 'contact_created':
      return { source: e.source };
    case 'message_received':
      return { channel_id: e.channelId, conversation_id: e.conversationId, kind: e.kind };
    case 'opportunity_created':
      return { opportunity_id: e.opportunityId, pipeline_id: e.pipelineId, stage_id: e.stageId };
    case 'stage_changed':
      return { opportunity_id: e.opportunityId, pipeline_id: e.pipelineId, from_stage_id: e.fromStageId, to_stage_id: e.toStageId, status: e.status };
    case 'field_changed':
      return { field: e.field, old_value: e.oldValue, new_value: e.newValue };
    case 'sale_created':
      return { sale_id: e.saleId, total: e.total };
  }
}

// ---------------------------------------------------------------------------------------------- condiciones

const CUSTOM_OPS = ['eq', 'neq', 'contains', 'gt', 'lt', 'is_empty', 'not_empty'] as const;
export const conditionSchema = z
  .strictObject({
    /** `custom:<variable>`, `tag`, `source`, `owner` o `consent`. */
    field: z.string().regex(/^(?:custom:[a-z][a-z0-9_]{0,39}|tag|source|owner|consent)$/),
    op: z.enum(['eq', 'neq', 'contains', 'gt', 'lt', 'is_empty', 'not_empty', 'has', 'not_has', 'is_set', 'is_unset']),
    value: z.string().trim().max(200).optional(),
  })
  .superRefine((c, ctx) => {
    const bad = (message: string): void => ctx.addIssue({ code: 'custom', path: ['op'], message });
    const needsValue = !['is_empty', 'not_empty', 'is_set', 'is_unset'].includes(c.op);
    if (needsValue && (c.value === undefined || c.value === '')) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Falta el valor de la condición' });
    if (c.field.startsWith('custom:') && !(CUSTOM_OPS as readonly string[]).includes(c.op)) bad('Esa comparación no aplica a un campo personalizado');
    if (c.field === 'tag') {
      if (c.op !== 'has' && c.op !== 'not_has') bad('Con etiquetas solo se puede elegir «tiene» o «no tiene»');
      else if (c.value && !uuid.safeParse(c.value).success) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Elige una etiqueta' });
    }
    if (c.field === 'source' && c.op !== 'eq' && c.op !== 'neq') bad('El origen solo se compara con «es» o «no es»');
    if (c.field === 'owner' && !['is_set', 'is_unset', 'eq', 'neq'].includes(c.op)) bad('El responsable solo se compara con «tiene», «no tiene», «es» o «no es»');
    if (c.field === 'owner' && (c.op === 'eq' || c.op === 'neq') && c.value && !uuid.safeParse(c.value).success) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Elige una persona' });
    if (c.field === 'consent' && (c.op !== 'eq' || !['unknown', 'granted', 'revoked'].includes(c.value ?? ''))) bad('El consentimiento se compara con «es» y uno de: sin definir, concedido o revocado');
  });
export type ConditionDef = z.infer<typeof conditionSchema>;

/** Lo que se sabe del contacto al evaluar las condiciones. */
export interface ContactFacts {
  readonly customs: Readonly<Record<string, string | number | boolean | readonly string[] | null>>;
  readonly tagIds: ReadonlySet<string>;
  readonly source: string;
  readonly ownerId: string | null;
  readonly consent: string;
}

const norm = (v: unknown): string => String(v).trim().toLowerCase();
const isEmpty = (v: ContactFacts['customs'][string] | undefined): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** ¿El contacto cumple TODAS las condiciones? Sin condiciones, siempre. */
export function meetsConditions(conditions: readonly ConditionDef[], f: ContactFacts): boolean {
  return conditions.every((c) => meets(c, f));
}

function meets(c: ConditionDef, f: ContactFacts): boolean {
  const v = c.value ?? '';
  if (c.field === 'tag') return c.op === 'has' ? f.tagIds.has(v) : !f.tagIds.has(v);
  if (c.field === 'source') return c.op === 'eq' ? norm(f.source) === norm(v) : norm(f.source) !== norm(v);
  if (c.field === 'consent') return f.consent === v;
  if (c.field === 'owner') return c.op === 'is_set' ? f.ownerId !== null : c.op === 'is_unset' ? f.ownerId === null : c.op === 'eq' ? f.ownerId === v : f.ownerId !== v;
  const cur = f.customs[c.field.slice('custom:'.length)];
  switch (c.op) {
    case 'is_empty':
      return isEmpty(cur);
    case 'not_empty':
      return !isEmpty(cur);
    case 'eq':
      return !isEmpty(cur) && (Array.isArray(cur) ? cur.some((x) => norm(x) === norm(v)) : norm(cur) === norm(v));
    case 'neq':
      return isEmpty(cur) || (Array.isArray(cur) ? !cur.some((x) => norm(x) === norm(v)) : norm(cur) !== norm(v));
    case 'contains':
      return !isEmpty(cur) && (Array.isArray(cur) ? cur.some((x) => norm(x).includes(norm(v))) : norm(cur).includes(norm(v)));
    case 'gt':
    case 'lt': {
      const a = typeof cur === 'number' ? cur : Number(cur);
      const b = Number(v.replace(',', '.'));
      if (isEmpty(cur) || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      return c.op === 'gt' ? a > b : a < b;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------- acciones

export const ACTION_TYPES = ['assign_user', 'assign_queue', 'move_stage', 'set_field', 'add_tag', 'remove_tag', 'create_task', 'send_text', 'send_template', 'wait', 'run_rule', 'start_agent'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_LABEL: Record<ActionType, string> = {
  assign_user: 'Asignar a una persona',
  assign_queue: 'Asignar con el reparto de una cola',
  move_stage: 'Mover la oportunidad de etapa',
  set_field: 'Cambiar un campo del contacto',
  add_tag: 'Poner una etiqueta',
  remove_tag: 'Quitar una etiqueta',
  create_task: 'Crear una tarea',
  send_text: 'Enviar un mensaje de texto',
  send_template: 'Enviar una plantilla de WhatsApp',
  wait: 'Esperar',
  run_rule: 'Ejecutar otra automatización',
  start_agent: 'Activar al agente de IA en la conversación',
};

/** Cuánto puede esperar una regla como mínimo y como máximo en una sola espera. */
export const MIN_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 30 * 86_400_000;
export const WAIT_UNITS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
export type WaitUnit = keyof typeof WAIT_UNITS;
/** Lo que dura una espera, en milisegundos. */
export const waitMs = (a: { amount: number; unit: WaitUnit }): number => a.amount * WAIT_UNITS[a.unit];
/** «2 horas», «1 día»…: para el historial y la prueba. */
export function waitText(a: { amount: number; unit: WaitUnit }): string {
  const one = a.amount === 1;
  return `${a.amount} ${{ minutes: one ? 'minuto' : 'minutos', hours: one ? 'hora' : 'horas', days: one ? 'día' : 'días' }[a.unit]}`;
}

export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('assign_user'), user_id: uuid }),
  z.strictObject({ type: z.literal('assign_queue'), queue_id: uuid }),
  z.strictObject({ type: z.literal('move_stage'), stage_id: uuid }),
  z.strictObject({ type: z.literal('set_field'), field: varKey, value: z.string().trim().max(500) }),
  z.strictObject({ type: z.literal('add_tag'), tag_id: uuid }),
  z.strictObject({ type: z.literal('remove_tag'), tag_id: uuid }),
  z.strictObject({ type: z.literal('create_task'), title: z.string().trim().min(1).max(120), due_in_hours: z.number().int().min(0).max(720).optional(), assignee: z.union([z.literal('owner'), uuid]).default('owner') }),
  z.strictObject({ type: z.literal('send_text'), text: z.string().trim().min(1).max(1000) }),
  z
    .strictObject({ type: z.literal('wait'), amount: z.number().int().min(1).max(43_200), unit: z.enum(['minutes', 'hours', 'days']) })
    .refine((a) => waitMs(a) >= MIN_WAIT_MS && waitMs(a) <= MAX_WAIT_MS, { message: 'La espera va de 1 minuto a 30 días', path: ['amount'] }),
  z.strictObject({ type: z.literal('run_rule'), automation_id: uuid }),
  z.strictObject({ type: z.literal('start_agent') }),
  z.strictObject({ type: z.literal('send_template'), channel_id: uuid, template_id: uuid, params: z.record(z.string().regex(/^(?:(?:header|body):[A-Za-z0-9_]{1,30}|button:\d{1,2}:[A-Za-z0-9_]{1,30})$/), z.string().max(200)).default({}) }),
]);
export type ActionDef = z.infer<typeof actionSchema>;

/** La definición completa de una regla, tal como la manda el editor. */
export const definitionSchema = z.strictObject({
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).max(MAX_CONDITIONS).default([]),
  actions: z.array(actionSchema).max(MAX_ACTIONS).default([]),
});
export type DefinitionInput = z.input<typeof definitionSchema>;
export type Definition = z.output<typeof definitionSchema>;

/** Variables que se pueden usar en textos de mensajes y tareas: `{{nombre}}` y `{{primer_nombre}}`. */
export function renderText(template: string, c: { name: string }): string {
  const first = c.name.trim().split(/\s+/)[0] ?? '';
  return template
    .replace(/\{\{\s*nombre\s*\}\}/gi, c.name)
    .replace(/\{\{\s*primer_nombre\s*\}\}/gi, first)
    .trim();
}

/** El valor de una variable de plantilla: el texto con las variables reemplazadas, en una sola línea y acotado (Meta rechaza saltos de línea). */
export function renderParam(template: string, c: { name: string }): string {
  return renderText(template, c).replace(/\s+/g, ' ').trim().slice(0, 200);
}
