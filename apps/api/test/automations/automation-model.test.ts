// M9.3 — Modelo puro de las automatizaciones (ADR-54; F20): forma válida de una regla, disparadores y condiciones.
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/modules/events';
import { actionSchema, conditionSchema, contextOf, definitionSchema, matchesTrigger, meetsConditions, renderParam, renderText, triggerSchema, MAX_ACTIONS, MAX_CONDITIONS, type ConditionDef, type ContactFacts } from '../../src/modules/automations/automation-model';

const U1 = '0190a000-0000-7000-8000-000000000001';
const U2 = '0190a000-0000-7000-8000-000000000002';

describe('disparador', () => {
  it('acepta cada tipo con su filtro y rechaza filtros ajenos o mal formados', () => {
    expect(triggerSchema.safeParse({ type: 'contact_created', filter: {} }).success).toBe(true);
    expect(triggerSchema.safeParse({ type: 'contact_created' }).success).toBe(true); // el filtro por omisión es vacío
    expect(triggerSchema.safeParse({ type: 'contact_created', filter: { source: 'formulario' } }).success).toBe(true);
    expect(triggerSchema.safeParse({ type: 'message_received', filter: { channel_id: U1 } }).success).toBe(true);
    expect(triggerSchema.safeParse({ type: 'message_received', filter: { channel_id: 'x' } }).success).toBe(false);
    expect(triggerSchema.safeParse({ type: 'stage_changed', filter: { pipeline_id: U1, to_stage_id: U2, to_status: 'won' } }).success).toBe(true);
    expect(triggerSchema.safeParse({ type: 'stage_changed', filter: { to_status: 'archived' } }).success).toBe(false);
    expect(triggerSchema.safeParse({ type: 'field_changed', filter: {} }).success).toBe(false); // el campo es obligatorio
    expect(triggerSchema.safeParse({ type: 'field_changed', filter: { field: 'servicio', value: 'corte' } }).success).toBe(true);
    expect(triggerSchema.safeParse({ type: 'field_changed', filter: { field: 'Mal Nombre' } }).success).toBe(false);
    expect(triggerSchema.safeParse({ type: 'sale_created', filter: { algo: 1 } }).success).toBe(false); // estricto
    expect(triggerSchema.safeParse({ type: 'otro', filter: {} }).success).toBe(false);
  });

  const e = (x: Partial<DomainEvent> & { type: DomainEvent['type'] }): DomainEvent => ({ contactId: U1, key: 'k', ...x }) as DomainEvent;

  it('un hecho dispara solo la regla de su tipo y respeta el filtro', () => {
    expect(matchesTrigger('contact_created', {}, e({ type: 'contact_created', source: 'manual' } as never))).toBe(true);
    expect(matchesTrigger('message_received', {}, e({ type: 'contact_created', source: 'manual' } as never))).toBe(false);
    expect(matchesTrigger('contact_created', { source: 'formulario' }, e({ type: 'contact_created', source: 'manual' } as never))).toBe(false);
    expect(matchesTrigger('message_received', { channel_id: U1 }, e({ type: 'message_received', channelId: U1, conversationId: U2, kind: 'text' } as never))).toBe(true);
    expect(matchesTrigger('message_received', { channel_id: U2 }, e({ type: 'message_received', channelId: U1, conversationId: U2, kind: 'text' } as never))).toBe(false);
    const stage = e({ type: 'stage_changed', opportunityId: U1, pipelineId: U1, fromStageId: null, toStageId: U2, status: 'won' } as never);
    expect(matchesTrigger('stage_changed', { to_status: 'won' }, stage)).toBe(true);
    expect(matchesTrigger('stage_changed', { to_status: 'lost' }, stage)).toBe(false);
    expect(matchesTrigger('stage_changed', { to_stage_id: U2, pipeline_id: U1 }, stage)).toBe(true);
    expect(matchesTrigger('stage_changed', { to_stage_id: U1 }, stage)).toBe(false);
  });

  it('un cambio de campo compara el campo y, si se pide, el valor nuevo sin distinguir mayúsculas ni espacios', () => {
    const f = e({ type: 'field_changed', field: 'servicio', oldValue: null, newValue: ' Corte ' } as never);
    expect(matchesTrigger('field_changed', { field: 'servicio' }, f)).toBe(true);
    expect(matchesTrigger('field_changed', { field: 'servicio', value: 'corte' }, f)).toBe(true);
    expect(matchesTrigger('field_changed', { field: 'servicio', value: 'barba' }, f)).toBe(false);
    expect(matchesTrigger('field_changed', { field: 'otro' }, f)).toBe(false);
  });

  it('el contexto guardado solo lleva identificadores y valores cortos, nunca texto de mensajes', () => {
    const ctx = contextOf(e({ type: 'message_received', channelId: U1, conversationId: U2, kind: 'text' } as never));
    expect(ctx).toEqual({ channel_id: U1, conversation_id: U2, kind: 'text' });
    expect(JSON.stringify(ctx).length).toBeLessThan(500);
  });
});

describe('condiciones', () => {
  const facts = (over: Partial<ContactFacts> = {}): ContactFacts => ({ customs: { servicio: 'Corte', visitas: 5, vip: true, intereses: ['barba', 'tinte'], vacio: '' }, tagIds: new Set([U1]), source: 'formulario', ownerId: U1, consent: 'granted', ...over });
  const c = (field: string, op: string, value?: string): ConditionDef => conditionSchema.parse({ field, op, ...(value === undefined ? {} : { value }) });

  it('valida la forma: cada campo admite solo sus comparaciones y pide valor cuando hace falta', () => {
    expect(conditionSchema.safeParse({ field: 'custom:servicio', op: 'eq', value: 'x' }).success).toBe(true);
    expect(conditionSchema.safeParse({ field: 'custom:servicio', op: 'eq' }).success).toBe(false); // falta el valor
    expect(conditionSchema.safeParse({ field: 'custom:servicio', op: 'is_empty' }).success).toBe(true);
    expect(conditionSchema.safeParse({ field: 'custom:servicio', op: 'has', value: 'x' }).success).toBe(false);
    expect(conditionSchema.safeParse({ field: 'tag', op: 'has', value: U1 }).success).toBe(true);
    expect(conditionSchema.safeParse({ field: 'tag', op: 'has', value: 'no-uuid' }).success).toBe(false);
    expect(conditionSchema.safeParse({ field: 'tag', op: 'eq', value: U1 }).success).toBe(false);
    expect(conditionSchema.safeParse({ field: 'source', op: 'contains', value: 'x' }).success).toBe(false);
    expect(conditionSchema.safeParse({ field: 'owner', op: 'is_set' }).success).toBe(true);
    expect(conditionSchema.safeParse({ field: 'owner', op: 'eq', value: U1 }).success).toBe(true);
    expect(conditionSchema.safeParse({ field: 'consent', op: 'eq', value: 'granted' }).success).toBe(true);
    expect(conditionSchema.safeParse({ field: 'consent', op: 'eq', value: 'quizá' }).success).toBe(false);
    expect(conditionSchema.safeParse({ field: 'telefono', op: 'eq', value: 'x' }).success).toBe(false);
  });

  it('campos personalizados: igualdad, contiene, comparaciones numéricas y vacío', () => {
    expect(meetsConditions([c('custom:servicio', 'eq', 'corte')], facts())).toBe(true); // sin distinguir mayúsculas
    expect(meetsConditions([c('custom:servicio', 'neq', 'barba')], facts())).toBe(true);
    expect(meetsConditions([c('custom:servicio', 'contains', 'ort')], facts())).toBe(true);
    expect(meetsConditions([c('custom:visitas', 'gt', '3')], facts())).toBe(true);
    expect(meetsConditions([c('custom:visitas', 'gt', '5')], facts())).toBe(false);
    expect(meetsConditions([c('custom:visitas', 'lt', '5,5')], facts())).toBe(true); // coma decimal
    expect(meetsConditions([c('custom:visitas', 'gt', 'abc')], facts())).toBe(false); // no numérico: no se cumple
    expect(meetsConditions([c('custom:intereses', 'eq', 'TINTE')], facts())).toBe(true); // multiselección
    expect(meetsConditions([c('custom:intereses', 'contains', 'bar')], facts())).toBe(true);
    expect(meetsConditions([c('custom:vacio', 'is_empty')], facts())).toBe(true);
    expect(meetsConditions([c('custom:inexistente', 'is_empty')], facts())).toBe(true);
    expect(meetsConditions([c('custom:servicio', 'is_empty')], facts())).toBe(false);
    expect(meetsConditions([c('custom:servicio', 'not_empty')], facts())).toBe(true);
    expect(meetsConditions([c('custom:inexistente', 'eq', 'x')], facts())).toBe(false);
    expect(meetsConditions([c('custom:inexistente', 'neq', 'x')], facts())).toBe(true); // sin valor «no es» x
  });

  it('etiquetas, origen, responsable y consentimiento', () => {
    expect(meetsConditions([c('tag', 'has', U1)], facts())).toBe(true);
    expect(meetsConditions([c('tag', 'not_has', U1)], facts())).toBe(false);
    expect(meetsConditions([c('tag', 'not_has', U2)], facts())).toBe(true);
    expect(meetsConditions([c('source', 'eq', 'FORMULARIO')], facts())).toBe(true);
    expect(meetsConditions([c('source', 'neq', 'manual')], facts())).toBe(true);
    expect(meetsConditions([c('owner', 'is_set')], facts())).toBe(true);
    expect(meetsConditions([c('owner', 'is_unset')], facts({ ownerId: null }))).toBe(true);
    expect(meetsConditions([c('owner', 'eq', U1)], facts())).toBe(true);
    expect(meetsConditions([c('owner', 'neq', U1)], facts())).toBe(false);
    expect(meetsConditions([c('consent', 'eq', 'granted')], facts())).toBe(true);
    expect(meetsConditions([c('consent', 'eq', 'revoked')], facts())).toBe(false);
  });

  it('todas deben cumplirse; sin condiciones siempre se cumple', () => {
    expect(meetsConditions([], facts())).toBe(true);
    expect(meetsConditions([c('source', 'eq', 'formulario'), c('tag', 'has', U1)], facts())).toBe(true);
    expect(meetsConditions([c('source', 'eq', 'formulario'), c('tag', 'has', U2)], facts())).toBe(false);
  });
});

describe('acciones y definición', () => {
  it('cada acción valida su forma de forma estricta', () => {
    expect(actionSchema.safeParse({ type: 'assign_user', user_id: U1 }).success).toBe(true);
    expect(actionSchema.safeParse({ type: 'assign_user', user_id: 'x' }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'assign_queue', queue_id: U1 }).success).toBe(true);
    expect(actionSchema.safeParse({ type: 'move_stage', stage_id: U1 }).success).toBe(true);
    expect(actionSchema.safeParse({ type: 'set_field', field: 'servicio', value: 'corte' }).success).toBe(true);
    expect(actionSchema.safeParse({ type: 'add_tag', tag_id: U1 }).success).toBe(true);
    expect(actionSchema.safeParse({ type: 'remove_tag', tag_id: U1 }).success).toBe(true);
    expect(actionSchema.parse({ type: 'create_task', title: 'Llamar a {{nombre}}' })).toMatchObject({ assignee: 'owner' });
    expect(actionSchema.safeParse({ type: 'create_task', title: 'x', due_in_hours: -1 }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'create_task', title: 'x', due_in_hours: 721 }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'create_task', title: 'x', assignee: 'cualquiera' }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'send_text', text: '' }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'send_text', text: 'x'.repeat(1001) }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'send_template', channel_id: U1, template_id: U2, params: { 'body:1': 'x', 'button:0:1': 'y' } }).success).toBe(true);
    expect(actionSchema.safeParse({ type: 'send_template', channel_id: U1, template_id: U2, params: { 'con espacio': 'x' } }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'http_request', url: 'https://x.test' }).success).toBe(false); // aún no existe (M9.5)
    expect(actionSchema.safeParse({ type: 'add_tag', tag_id: U1, extra: 1 }).success).toBe(false);
  });

  it('una definición admite hasta 10 condiciones y 10 acciones', () => {
    const cond = { field: 'source', op: 'eq', value: 'x' };
    const act = { type: 'add_tag', tag_id: U1 };
    const trigger = { type: 'contact_created', filter: {} };
    expect(definitionSchema.safeParse({ trigger, conditions: Array(MAX_CONDITIONS).fill(cond), actions: Array(MAX_ACTIONS).fill(act) }).success).toBe(true);
    expect(definitionSchema.safeParse({ trigger, conditions: Array(MAX_CONDITIONS + 1).fill(cond), actions: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger, conditions: [], actions: Array(MAX_ACTIONS + 1).fill(act) }).success).toBe(false);
    expect(definitionSchema.safeParse({ trigger, conditions: [], actions: [], otra: 1 }).success).toBe(false);
  });
});

describe('variables de texto', () => {
  it('reemplaza {{nombre}} y {{primer_nombre}}; lo demás queda tal cual', () => {
    expect(renderText('Hola {{primer_nombre}}, {{ nombre }}! {{otra}}', { name: 'Ana María Pérez' })).toBe('Hola Ana, Ana María Pérez! {{otra}}');
    expect(renderText('Hola {{PRIMER_NOMBRE}}', { name: '  Luis  Vega' })).toBe('Hola Luis');
  });

  it('el valor de una plantilla va en una línea y acotado a 200', () => {
    expect(renderParam('Hola\n{{nombre}}\t!', { name: 'Ana' })).toBe('Hola Ana !');
    expect(renderParam('x'.repeat(300), { name: 'Ana' })).toHaveLength(200);
  });
});
