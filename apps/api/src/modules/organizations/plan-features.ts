/**
 * Módulos que un plan puede encender (prototipo: «cada plan activa o apaga módulos del menú»). Única fuente: la web pinta los
 * interruptores desde `GET /v1/platform/plans` (`feature_catalog`), así que un módulo nuevo se añade AQUÍ y nada más.
 * Que un plan lo encienda no lo construye: los módulos (campañas, flujos, agentes IA, telefonía…) llegan en sus hitos.
 */
export const PLAN_FEATURES = [
  { key: 'kanban', label: 'Kanban' },
  { key: 'agenda', label: 'Agenda' },
  { key: 'campaigns', label: 'Campañas' },
  { key: 'flows', label: 'Flujos' },
  { key: 'ai_agents', label: 'Agentes IA' },
  { key: 'external_api', label: 'API externa' },
  { key: 'telephony', label: 'Telefonía' },
] as const;

export type PlanFeatureKey = (typeof PLAN_FEATURES)[number]['key'];
export const PLAN_FEATURE_KEYS = PLAN_FEATURES.map((f) => f.key) as readonly PlanFeatureKey[];

/** Estado completo y normalizado: toda clave conocida presente (las ausentes quedan apagadas); las claves ajenas se descartan. */
export function normalizeFeatures(raw: unknown): Record<PlanFeatureKey, boolean> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, src[k] === true])) as Record<PlanFeatureKey, boolean>;
}
