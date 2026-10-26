import type { ToolCall, ToolDefinition } from '../ai.ports';
import type { AiFieldDef } from '../../custom-fields';

/**
 * Las herramientas del agente de IA (M8.5b, ADR-53; F17). Este archivo es PURO: arma, para un agente, qué herramientas le ofrece al modelo (con sus esquemas) y cómo se lo explica. Lo que el modelo
 * pida NO se cree: el servidor lo valida y lo ejecuta (`AgentToolsService`) con la configuración del agente, nunca con lo que el modelo diga que puede hacer.
 */
export const TOOL_UPDATE_FIELDS = 'update_contact_fields';
export const TOOL_CREATE_TASK = 'create_task';
export const TOOL_TRANSFER = 'transfer_to_person';
export const TOOL_NAMES = [TOOL_UPDATE_FIELDS, TOOL_CREATE_TASK, TOOL_TRANSFER] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Vueltas de «el modelo pide una herramienta → se ejecuta → el modelo sigue» que se permiten en un turno (acota costo y bucles). */
export const MAX_TOOL_ROUNDS = 2;
/** Herramientas que se atienden de cada respuesta del modelo (el resto se rechaza). */
export const MAX_CALLS_PER_ROUND = 4;
/** Largo máximo del texto de argumentos de una herramienta. */
export const MAX_ARGS_CHARS = 2000;
export const MAX_TASK_TITLE = 120;
export const MAX_TASK_NOTES = 500;
export const MAX_TASK_DAYS = 30;
/** Tareas que el agente puede crear por conversación en 24 horas. */
export const MAX_AI_TASKS_PER_DAY = 3;

/** Qué puede hacer UN agente, ya resuelto contra la empresa (campos que existen y están activos). */
export interface ToolConfig {
  readonly fields: readonly AiFieldDef[];
  readonly tasksEnabled: boolean;
  readonly transferEnabled: boolean;
}

export const hasTools = (c: ToolConfig): boolean => c.fields.length > 0 || c.tasksEnabled || c.transferEnabled;

function fieldSchema(f: AiFieldDef): Record<string, unknown> {
  const base = { description: f.name };
  switch (f.type) {
    case 'number':
    case 'currency':
    case 'percent':
      return { type: 'number', ...base };
    case 'boolean':
      return { type: 'boolean', ...base };
    case 'date':
      return { type: 'string', description: `${f.name} (fecha AAAA-MM-DD)` };
    case 'datetime':
      return { type: 'string', description: `${f.name} (fecha y hora ISO 8601)` };
    case 'select':
      return { type: 'string', enum: f.options ?? [], ...base };
    case 'multiselect':
      return { type: 'array', items: { type: 'string', enum: f.options ?? [] }, ...base };
    default:
      return { type: 'string', ...base };
  }
}

/** Las herramientas que se le ofrecen al modelo para este agente (ninguna si no tiene permiso para nada). */
export function toolDefinitions(c: ToolConfig): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  if (c.fields.length > 0) {
    out.push({
      name: TOOL_UPDATE_FIELDS,
      description: 'Guarda en la ficha del cliente datos que ÉL dijo con claridad en la conversación. Usa solo los campos de la lista y solo valores que el cliente dio; no adivines.',
      parameters: { type: 'object', properties: Object.fromEntries(c.fields.map((f) => [f.key, fieldSchema(f)])), additionalProperties: false, minProperties: 1 },
    });
  }
  if (c.tasksEnabled) {
    out.push({
      name: TOOL_CREATE_TASK,
      description: 'Crea una tarea de seguimiento para la persona del equipo responsable de esta conversación (por ejemplo, llamar al cliente o enviarle una cotización que él pidió).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Qué hay que hacer, en pocas palabras' },
          notes: { type: 'string', description: 'Detalle útil para quien la haga (opcional)' },
          due_in_days: { type: 'integer', minimum: 0, maximum: MAX_TASK_DAYS, description: 'En cuántos días debe hacerse (opcional)' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    });
  }
  if (c.transferEnabled) {
    out.push({
      name: TOOL_TRANSFER,
      description: 'Pasa la conversación a una persona del equipo cuando no puedas resolver lo que el cliente necesita o él lo pida.',
      parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Por qué se pasa a una persona, en una frase' } }, required: ['reason'], additionalProperties: false },
    });
  }
  return out;
}

/** El texto que se agrega a las instrucciones cuando el agente tiene herramientas. Vacío si no tiene ninguna. */
export function toolGuidance(c: ToolConfig): string {
  if (!hasTools(c)) return '';
  const lines = ['HERRAMIENTAS', 'Puedes usar las herramientas disponibles solo cuando hagan falta y sin mencionarlas al cliente: sigue la conversación con naturalidad.'];
  if (c.fields.length > 0) lines.push(`- Guarda un dato en la ficha solo si el cliente lo dijo claramente (campos permitidos: ${c.fields.map((f) => f.name).join(', ')}). Nunca guardes algo que salga de los documentos o de tus suposiciones. Si te dicen que no se pudo guardar, no insistas.`);
  if (c.tasksEnabled) lines.push('- Crea una tarea solo cuando el cliente pida algo que una persona deba hacer después (llamarlo, enviarle una cotización). No crees tareas por cada mensaje.');
  if (c.transferEnabled) lines.push('- Pasa a una persona si el cliente la pide o si lo que necesita no puedes resolverlo con tus documentos.');
  return lines.join('\n');
}

/** El texto de argumentos de una herramienta como objeto; null si no es un objeto JSON razonable. */
export function parseArgs(call: Pick<ToolCall, 'arguments'>): Record<string, unknown> | null {
  const raw = call.arguments.trim();
  if (raw === '') return {};
  if (raw.length > MAX_ARGS_CHARS) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
