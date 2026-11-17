import { ApiError } from '../../lib/api';
import { friendlyError } from '../../lib/errors';
import type { SavedList } from '../../lib/types';
import type { PillKind } from '../../ui/Pill';
import type { AudienceState, Campaign, CampaignStatus, ChannelKind, RecipientStatus, SkipReason } from './useCampaigns';

/** Los estados de una campaña, con las palabras del prototipo (Programada, En curso, Finalizada…). */
export const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: 'Borrador',
  scheduled: 'Programada',
  running: 'En curso',
  paused: 'Pausada',
  completed: 'Finalizada',
  cancelled: 'Cancelada',
  failed: 'Fallida',
};
export const STATUS_KIND: Record<CampaignStatus, PillKind> = { draft: 'muted', scheduled: 'warn', running: 'info', paused: 'warn', completed: 'ok', cancelled: 'muted', failed: 'crit' };

/** Por qué un contacto de la audiencia recibe o no el mensaje. «No contactar» es la baja: nunca se le escribe. */
export const STATE_LABEL: Record<AudienceState, string> = {
  eligible: 'Recibirá el mensaje',
  revoked: 'No contactar',
  excluded: 'Desmarcado',
  no_phone: 'Sin teléfono',
  no_consent: 'Sin consentimiento definido',
  duplicate: 'Teléfono repetido',
};
export const STATE_KIND: Record<AudienceState, PillKind> = { eligible: 'ok', revoked: 'crit', excluded: 'muted', no_phone: 'warn', no_consent: 'warn', duplicate: 'muted' };

export const KIND_TITLE: Record<ChannelKind, string> = { official: 'WhatsApp API oficial', qr: 'WhatsApp QR · no oficial' };
export const KIND_HINT: Record<ChannelKind, string> = { official: 'Solo plantillas aprobadas por Meta', qr: 'Texto libre, sin plantillas' };

/** El texto de la columna «Canal» de la tabla: la conexión y si lleva plantilla o texto libre. */
export const channelLabel = (c: Campaign): string => (c.channel ? `${c.channel.name} · ${c.mode === 'template' ? 'plantilla' : 'texto libre'}` : 'Conexión no disponible');

/** El nombre de la base de destinatarios de una campaña. */
export function baseLabel(c: Campaign, lists: readonly SavedList[]): string {
  if (c.audience.source === 'list') return lists.find((l) => l.id === c.audience.list_id)?.name ?? 'Una lista';
  return 'Toda la base';
}

/** Cuándo: la hora programada o, si no, el día en que se creó la campaña. */
export const whenLabel = (c: Campaign): string => (c.scheduled_at ? new Date(c.scheduled_at).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' }) : new Date(c.created_at).toLocaleDateString('es-EC', { dateStyle: 'short' }));

/**
 * El texto de un error de campañas: las reglas del servidor (pausa mínima, tope, variables, consentimiento…) ya vienen redactadas para la persona, así que se muestran tal cual;
 * si hay varios campos con problema, el primero. Lo demás usa el texto de siempre.
 */
export function campaignError(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.status === 400 && e.details.length > 0) return e.details[0]!.message;
  return friendlyError(e, fallback);
}

/** ¿Un contacto con este estado cuenta como destinatario? Solo si recibe el mensaje; el resto se muestra con su motivo. */
export const receives = (s: AudienceState): boolean => s === 'eligible';

/** El estado de cada destinatario en el informe (las palabras del prototipo: Respondió, Leído, Entregado, Fallido, Pendiente). */
export const RECIPIENT_STATUS_LABEL: Record<RecipientStatus, string> = { replied: 'Respondió', read: 'Leído', delivered: 'Entregado', sent: 'Enviado', queued: 'En cola', pending: 'Pendiente', failed: 'Fallido', skipped: 'Omitido' };
export const RECIPIENT_STATUS_KIND: Record<RecipientStatus, PillKind> = { replied: 'ok', read: 'info', delivered: 'muted', sent: 'muted', queued: 'muted', pending: 'warn', failed: 'crit', skipped: 'muted' };
/** El orden del filtro «Estado»: de lo mejor a lo peor. */
export const RECIPIENT_STATUS_ORDER: readonly RecipientStatus[] = ['replied', 'read', 'delivered', 'sent', 'queued', 'pending', 'failed', 'skipped'];

/** Por qué un destinatario NO recibió el mensaje. */
export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  revoked: 'No contactar',
  no_consent: 'Sin consentimiento',
  no_phone: 'Sin teléfono',
  duplicate: 'Teléfono repetido',
  out_of_scope: 'Fuera de tu alcance',
  excluded: 'Desmarcado a mano',
  missing_variable: 'Falta un dato del contacto',
  cancelled: 'Campaña cancelada',
};

/** Una tasa de 0 a 1 como porcentaje; «—» mientras no haya con qué calcularla. */
export const percent = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 1000) / 10} %`);
