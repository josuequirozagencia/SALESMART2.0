/**
 * Cuándo el agente pasa la conversación a una persona (M8.5, ADR-53). Reglas DETERMINISTAS, no del modelo: no dependen de que la IA «decida» bien. Hoy: el cliente pide hablar con una persona,
 * se llegó al máximo de turnos del agente en la conversación o hubo un problema (sin créditos, IA caída, mensaje que no es de texto).
 */
export type HandoffReason = 'requested' | 'turn_limit' | 'unsupported_media' | 'ai_error' | 'no_support';

/** Máximo de respuestas seguidas del agente en una conversación sin que una persona intervenga: pasado esto, la pasa a una persona (evita bucles y gasto sin fin). */
export const MAX_AGENT_TURNS = 20;
/** Veces seguidas que el agente puede quedarse SIN respaldo en los documentos antes de pasar a una persona. */
export const MAX_UNSUPPORTED_STREAK = 2;

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const PERSON = '(?:asesor(?:a)?|humano|persona|agente|encargad[oa]|vendedor(?:a)?|ejecutiv[oa]|alguien|representante|operador(?:a)?|gerente|supervisor(?:a)?)';
const VERB = '(?:hablar|conversar|comunica(?:me|r|rme)?|pasar(?:me)?|pasame|contactar(?:me)?|atienda(?:n)?|atender(?:me)?|llamen|llamar(?:me)?|quiero|necesito|prefiero|puedo|pueden|podria|podrian|me pasas|me pasan)';
const REQUEST = new RegExp(`\\b${VERB}\\b[^.?!\\n]{0,40}\\b${PERSON}\\b|\\b(?:no|ni)\\s+(?:quiero|me)[^.?!\\n]{0,30}\\b(?:robot|bot|maquina|inteligencia artificial)\\b|\\b(?:eres|es|sois)\\s+(?:un\\s+)?(?:bot|robot)\\b`, 'i');
const ONLY = /^\s*(?:asesor(?:a)?|humano|una persona|un asesor|una asesora|un humano|persona real|atencion al cliente|agente humano)\s*[.!?]*\s*$/i;

/**
 * ¿El cliente está pidiendo hablar con una persona? Mira el texto sin acentos y en minúsculas: «Quiero hablar con un asesor», «¿Me pueden pasar con alguien?», «No quiero hablar con un robot», «Asesor». Es
 * conservador a propósito: una consulta normal («el asesor de mi cita fue muy amable», «¿cuál es el precio?») no la activa. Un falso negativo se resuelve solo (el cliente insiste) y un falso positivo
 * cuesta poco (una persona retoma la conversación).
 */
export function asksForPerson(text: string): boolean {
  const t = fold(text).trim();
  if (t === '') return false;
  return ONLY.test(t) || REQUEST.test(t);
}

/** Lo que se le dice al cliente cuando se le pasa con una persona (no depende del modelo). */
export const HANDOFF_MESSAGE = 'Claro, te comunico con una persona del equipo. En breve te atenderán.';

/** Texto de la nota interna que ve el equipo cuando el agente deja la conversación. */
export function handoffNote(agent: string, reason: HandoffReason | 'human_message' | 'human_took' | 'manual' | 'no_credits'): string {
  switch (reason) {
    case 'requested': return `El agente ${agent} pasó la conversación a una persona: el cliente pidió hablar con alguien del equipo.`;
    case 'turn_limit': return `El agente ${agent} pasó la conversación a una persona: llegó al máximo de respuestas seguidas.`;
    case 'unsupported_media': return `El agente ${agent} pasó la conversación a una persona: el cliente envió algo que no es texto (imagen, audio o archivo) y el agente solo lee texto.`;
    case 'ai_error': return `El agente ${agent} pasó la conversación a una persona: el servicio de IA no estuvo disponible.`;
    case 'no_support': return `El agente ${agent} pasó la conversación a una persona: no encontró en sus documentos lo que el cliente preguntó.`;
    case 'no_credits': return `El agente ${agent} dejó de atender esta conversación: la empresa se quedó sin créditos de IA.`;
    case 'human_message': return `El agente ${agent} dejó de atender: una persona escribió en la conversación.`;
    case 'human_took': return `El agente ${agent} dejó de atender: una persona tomó la conversación.`;
    case 'manual': return `El agente ${agent} fue pausado por una persona.`;
  }
}
