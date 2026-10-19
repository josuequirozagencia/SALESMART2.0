import type { ChatMessage, ConversationStatus } from '../../lib/types';
import type { PillKind } from '../../ui/Pill';

export const STATUS_PILL: Record<ConversationStatus, { label: string; kind: PillKind }> = {
  unassigned: { label: 'Sin asignar', kind: 'warn' },
  pending: { label: 'Por aceptar', kind: 'warn' },
  working: { label: 'Trabajando', kind: 'ok' },
  waiting: { label: 'Esperando al cliente', kind: 'info' },
  closed: { label: 'Finalizada', kind: 'muted' },
};

const hm = (d: Date): string => d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false });
const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Hora si es de hoy, «Ayer» o dd/mm: la marca de tiempo de una fila del listado. */
export function chatTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return hm(d);
  if (days === 1) return 'Ayer';
  return d.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit' });
}

/** Hora de un mensaje dentro del hilo. */
export const bubbleTime = (iso: string): string => hm(new Date(iso));

/** Título del separador de día del hilo. */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return 'Hoy';
  if (days === 1) return 'Ayer';
  return d.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

const KIND_LABEL: Record<string, string> = {
  image: 'Imagen',
  audio: 'Audio',
  video: 'Video',
  document: 'Documento',
  sticker: 'Sticker',
  location: 'Ubicación',
  contacts: 'Contacto',
  interactive: 'Respuesta',
  button: 'Botón',
  template: 'Plantilla',
  unsupported: 'Mensaje no compatible',
};
export const kindLabel = (kind: string): string => KIND_LABEL[kind] ?? 'Mensaje';

/** Lo que se dice de un mensaje que no es solo texto (hasta M5.6 los archivos no se descargan). */
export function describeExtra(m: ChatMessage): string | null {
  if (m.kind === 'location') {
    const loc = (m.extra?.['location'] ?? null) as { name?: unknown; address?: unknown; latitude?: unknown; longitude?: unknown } | null;
    const place = [loc?.name, loc?.address].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ');
    if (place) return place;
    return typeof loc?.latitude === 'number' && typeof loc.longitude === 'number' ? `${loc.latitude}, ${loc.longitude}` : null;
  }
  if (m.kind === 'contacts') {
    const n = m.extra?.['contacts_count'];
    return typeof n === 'number' ? (n === 1 ? '1 contacto compartido' : `${n} contactos compartidos`) : null;
  }
  return null;
}
