/**
 * Reglas puras de los seguimientos automáticos del agente (v11 S5, ADR-68). Sin base de datos ni reloj: reciben una «foto» de la conversación y deciden. Así lo que se prueba aquí es exactamente lo que decide
 * el motor.
 */

export const SCENARIO = 'stopped_replying' as const;
export const MAX_STEPS = 5;
export const MIN_DELAY_MINUTES = 5;
export const MAX_DELAY_MINUTES = 7 * 24 * 60;
export const MAX_FIXED_TEXT = 1000;
/** Cuánto espera un paso que no pudo salir por algo pasajero antes de reintentar. */
export const RETRY_MS = 60_000;
/** Una tarea que murió a medias deja el paso «tomado»: pasado este tiempo se retoma. */
export const LEASE_MS = 3 * 60_000;
export const RUN_BATCH = 20;

/** Variables que un texto fijo puede llevar: el nombre del contacto y el del agente. (El teléfono no: no hace falta decírselo al cliente. Los campos personalizados, más adelante.) */
export const FOLLOW_UP_VARIABLES = ['primer_nombre', 'nombre', 'mi_nombre'] as const;

/** Por qué un paso pendiente ya no hace falta. */
export type CancelReason =
  | 'client_replied'
  | 'human_intervened'
  | 'agent_stopped'
  | 'conversation_closed'
  | 'owner_changed'
  | 'consent_revoked'
  | 'agent_unavailable'
  | 'disabled'
  | 'step_removed'
  | 'superseded';

/** Por qué un paso que sí hacía falta no pudo salir. */
export type SkipReason = 'window_closed' | 'no_credits' | 'missing_variable' | 'automation_unavailable' | 'daily_limit' | 'channel_unavailable' | 'ai_unavailable' | 'empty_reply';

/** Estos motivos terminan la cadena: los pasos que faltan tampoco podrían salir (la ventana de WhatsApp no se reabre sola, no hay créditos, el canal no sirve o se llegó al tope del día). */
export const ENDS_CHAIN: ReadonlySet<SkipReason> = new Set<SkipReason>(['window_closed', 'no_credits', 'channel_unavailable', 'daily_limit']);

export interface RunFacts {
  readonly chainInboundAt: Date;
  readonly ownerId: string | null;
}

/** Lo que hay que saber de la conversación EN ESTE INSTANTE para decidir si un paso todavía hace falta. */
export interface Snapshot {
  readonly conversation: { readonly status: string; readonly deleted: boolean; readonly ownerId: string | null; readonly lastInboundAt: Date | null } | null;
  /** Consentimiento del contacto (`revoked` cancela). */
  readonly consent: string | null;
  /** El agente existe, no está borrado y está activo. */
  readonly agentActive: boolean;
  /** El agente de la conexión de la conversación sigue siendo este. */
  readonly agentLinked: boolean;
  /** Estado del agente en la conversación; `null` si nunca intervino. */
  readonly agentState: string | null;
  /** Una persona escribió (mensaje humano, también desde el teléfono) después de armar la cadena. */
  readonly humanWroteAfterAnchor: boolean;
  readonly enabled: boolean;
  readonly stepExists: boolean;
}

/** `null` si el paso sigue haciendo falta; si no, el motivo por el que se cancela. El orden importa: lo más definitivo primero. */
export function cancelReason(run: RunFacts, s: Snapshot): CancelReason | null {
  const c = s.conversation;
  if (!c || c.deleted || c.status === 'closed') return 'conversation_closed';
  if (s.consent === 'revoked') return 'consent_revoked';
  if (c.lastInboundAt && c.lastInboundAt.getTime() > run.chainInboundAt.getTime()) return 'client_replied';
  if (s.humanWroteAfterAnchor) return 'human_intervened';
  if (s.agentState !== 'active') return 'agent_stopped';
  if (c.ownerId !== run.ownerId) return 'owner_changed';
  if (!s.agentActive || !s.agentLinked) return 'agent_unavailable';
  if (!s.enabled) return 'disabled';
  if (!s.stepExists) return 'step_removed';
  return null;
}

/** ¿Hay que armar una cadena nueva? Solo si el cliente escribió después de la última cadena (cada mensaje del cliente gana a lo sumo UNA) y hay un mensaje del cliente al que referirse. */
export function shouldStartChain(i: { lastInboundAt: Date | null; existingChainInboundAts: readonly Date[] }): boolean {
  if (!i.lastInboundAt) return false;
  return !i.existingChainInboundAts.some((d) => d.getTime() === i.lastInboundAt!.getTime());
}

/** La hora de un paso: `ancla + retraso`; si cae fuera del horario, al próximo instante abierto (`next` lo calcula el calendario de la cola; `null` = no hay). */
export function dueAt(anchor: Date, delayMinutes: number): Date {
  return new Date(anchor.getTime() + delayMinutes * 60_000);
}

/** Los nombres de las variables de un texto que no están permitidas en un seguimiento. */
export function disallowedVariables(names: readonly string[]): string[] {
  const ok = new Set<string>(FOLLOW_UP_VARIABLES);
  return names.filter((n) => !ok.has(n));
}
