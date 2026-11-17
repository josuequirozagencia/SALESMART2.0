/**
 * La baja por palabra clave de las campañas (v17 · 17.5, ADR-72 #3). Si un contacto responde a un mensaje de campaña con una de estas frases y NADA MÁS, se entiende que pide no recibir más mensajes.
 * Es a propósito conservador: la frase tiene que ser TODO el mensaje (sin mayúsculas, acentos ni signos), porque «quiero dar de baja mi plan» o «cancelar mi cita» no son una baja de mensajes y revocar
 * por error le quitaría un cliente al negocio. «Cancelar» a secas queda fuera por lo mismo (también se usa para citas y pedidos).
 */
const PHRASES: readonly string[] = [
  'baja',
  'stop',
  'unsubscribe',
  'no mas',
  'no mas mensajes',
  'ya no mas',
  'dar de baja',
  'darme de baja',
  'dame de baja',
  'quiero la baja',
  'no quiero mas mensajes',
  'no quiero recibir mas mensajes',
  'no me escriban mas',
  'no me escribas mas',
  'no me envien mas mensajes',
  'no me envies mas mensajes',
];
const SET = new Set(PHRASES);
const MAX_LEN = 40;

/** Minúsculas, sin acentos, sin signos y con los espacios colapsados: «¡NO MÁS!» → «no mas». */
export function normalizeOptOut(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ¿Este mensaje del cliente es, entero, una petición de baja? */
export function isOptOutText(text: string | null | undefined): boolean {
  if (!text || text.length > MAX_LEN * 2) return false;
  const n = normalizeOptOut(text);
  return n.length > 0 && n.length <= MAX_LEN && SET.has(n);
}
