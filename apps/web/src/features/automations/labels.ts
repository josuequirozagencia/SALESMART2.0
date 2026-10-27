import type { PillKind } from '../../ui/Pill';
import type { ActionType, AutomationStatus, TriggerType, WaitUnit } from './useAutomations';

export const STATUS_LABEL: Record<AutomationStatus, string> = { draft: 'Borrador', active: 'Activa', paused: 'En pausa' };
export const STATUS_KIND: Record<AutomationStatus, PillKind> = { draft: 'muted', active: 'ok', paused: 'warn' };

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  contact_created: 'Se crea un contacto',
  message_received: 'Llega un mensaje del cliente',
  opportunity_created: 'Se crea una oportunidad',
  stage_changed: 'Una oportunidad cambia de etapa',
  field_changed: 'Cambia un campo del contacto',
  sale_created: 'Se registra una venta',
};
export const TRIGGERS = Object.keys(TRIGGER_LABEL) as TriggerType[];

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
export const ACTIONS = Object.keys(ACTION_LABEL) as ActionType[];

/** Una frase que ayuda a elegir cada acción. */
export const ACTION_HINT: Record<ActionType, string> = {
  assign_user: 'Cambia el responsable del contacto y de sus oportunidades abiertas. No toca las conversaciones.',
  assign_queue: 'Reparte la conversación «sin asignar» del contacto con las reglas de esa cola.',
  move_stage: 'Mueve la oportunidad abierta del contacto en el pipeline de esa etapa. Ganar y perder no se hacen aquí.',
  set_field: 'Escribe un valor en un campo personalizado del contacto.',
  add_tag: 'Solo etiquetas personalizadas: las del sistema las pone el sistema.',
  remove_tag: 'Solo etiquetas personalizadas.',
  create_task: 'Usa {{nombre}} o {{primer_nombre}} en el título.',
  send_text: 'Solo a una conversación abierta y dentro de las 24 horas desde el último mensaje del cliente. Nunca abre una conversación.',
  send_template: 'Puede abrir la conversación. Necesita una plantilla aprobada por Meta.',
  wait: 'La ejecución se pausa y sigue con las acciones de abajo cuando pase el tiempo (de 1 minuto a 30 días). Si pausas o borras la regla, o borras al contacto, no continúa; si editas la regla, lo que ya empezó sigue como estaba.',
  run_rule: 'Corre otra automatización activa con este contacto, en su propia ejecución y solo si el contacto cumple sus condiciones. Si se llaman en círculo, se corta.',
  start_agent: 'El agente de la conexión de la conversación contesta lo que el cliente escriba desde ahora (lo anterior no). Si una persona escribe después, el agente se pausa otra vez.',
};
export const UNIT_LABEL: Record<WaitUnit, string> = { minutes: 'minutos', hours: 'horas', days: 'días' };

export const RUN_LABEL = { queued: 'En cola', waiting: 'Esperando', done: 'Hecha', skipped: 'Omitida', failed: 'Con fallos' } as const;
export const RUN_KIND: Record<keyof typeof RUN_LABEL, PillKind> = { queued: 'info', waiting: 'accent', done: 'ok', skipped: 'muted', failed: 'crit' };
export const STEP_LABEL = { done: 'Hecho', skipped: 'Omitido', failed: 'Falló' } as const;
export const STEP_KIND = { done: 'ok', skipped: 'muted', failed: 'crit' } as const satisfies Record<string, PillKind>;
export const WOULD_LABEL = { do: 'Lo haría', skip: 'Se omitiría', fail: 'Fallaría' } as const;
export const WOULD_KIND = { do: 'ok', skip: 'muted', fail: 'crit' } as const satisfies Record<string, PillKind>;

export const CONSENT_LABEL = { unknown: 'Sin definir', granted: 'Concedido', revoked: 'Revocado' } as const;

export const OP_LABEL: Record<string, string> = {
  eq: 'es igual a',
  neq: 'es distinto de',
  contains: 'contiene',
  gt: 'es mayor que',
  lt: 'es menor que',
  is_empty: 'está vacío',
  not_empty: 'no está vacío',
  has: 'tiene',
  not_has: 'no tiene',
  is_set: 'tiene responsable',
  is_unset: 'no tiene responsable',
};
export const NO_VALUE_OPS = ['is_empty', 'not_empty', 'is_set', 'is_unset'];

/** Los operadores que el servidor acepta según el campo de la condición. */
export function opsFor(field: string): string[] {
  if (field.startsWith('custom:')) return ['eq', 'neq', 'contains', 'gt', 'lt', 'is_empty', 'not_empty'];
  if (field === 'tag') return ['has', 'not_has'];
  if (field === 'source') return ['eq', 'neq'];
  if (field === 'owner') return ['is_set', 'is_unset', 'eq', 'neq'];
  return ['eq']; // consentimiento
}

/** Orígenes conocidos de un contacto (el servidor acepta cualquier texto: el origen puede ser el de una integración). */
export const SOURCE_SUGGESTIONS = ['manual', 'import', 'meta_ctwa', 'whatsapp', 'form'];
