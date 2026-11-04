/**
 * Distribución de las columnas del Inbox en escritorio (ADR-60, Fase 3): Conversaciones | Chat | Contacto. El chat es la única columna flexible; las otras dos tienen ancho en píxeles
 * dentro de estos rangos. Funciones puras: la pantalla solo las aplica.
 */
export const LIST_RANGE = { min: 260, def: 300, max: 420 } as const;
export const CONTACT_RANGE = { min: 280, def: 300, max: 420 } as const;
/** El chat nunca baja de este ancho en escritorio. */
export const CHAT_MIN = 520;
/** Bajo este ancho de ventana el panel de contacto nace plegado (se abre con el botón de la cabecera y se recuerda). */
export const CONTACT_OPEN_FROM = 1440;

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export interface LayoutInput {
  /** Ancho disponible para las tres columnas (la caja del Inbox). 0 o no finito = aún no se sabe: no se recorta nada. */
  width: number;
  listWidth: number;
  contactWidth: number;
  listOpen: boolean;
  contactOpen: boolean;
}

export interface ResolvedLayout {
  list: number;
  contact: number;
  listShown: boolean;
  contactShown: boolean;
  /** El panel de contacto está pedido pero no cabe (el chat bajaría de su mínimo): no se muestra y el botón se desactiva. */
  contactBlocked: boolean;
  /** El ancho máximo que puede tomar cada columna ahora mismo (para los divisores). */
  listMax: number;
  contactMax: number;
}

/**
 * Prioridad al reducir el espacio: 1.º se pliega el panel de contacto, 2.º se estrecha la lista hasta su mínimo, y el chat nunca baja de ${CHAT_MIN} px. Los paneles no se superponen.
 */
export function resolveLayout(i: LayoutInput): ResolvedLayout {
  const width = Number.isFinite(i.width) && i.width > 0 ? i.width : Number.POSITIVE_INFINITY;
  const listWanted = i.listOpen ? clamp(i.listWidth, LIST_RANGE.min, LIST_RANGE.max) : 0;
  const contactWanted = clamp(i.contactWidth, CONTACT_RANGE.min, CONTACT_RANGE.max);
  const fits = listWanted + contactWanted + CHAT_MIN <= width;
  const contactShown = i.contactOpen && fits;
  const contact = contactShown ? contactWanted : 0;
  const list = i.listOpen ? clamp(Math.min(listWanted, width - CHAT_MIN - contact), LIST_RANGE.min, LIST_RANGE.max) : 0;
  return {
    list,
    contact,
    listShown: i.listOpen,
    contactShown,
    contactBlocked: i.contactOpen && !fits,
    listMax: clamp(width - CHAT_MIN - contact, LIST_RANGE.min, LIST_RANGE.max),
    contactMax: clamp(width - CHAT_MIN - list, CONTACT_RANGE.min, CONTACT_RANGE.max),
  };
}
