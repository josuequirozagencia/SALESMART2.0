import type { AudienceContact } from '../contacts';
import { OFFICIAL_DAILY_CAP, QR_CAMPAIGN_SHARE } from './campaigns.dto';

/** Por qué un contacto NO recibirá el mensaje de una campaña (ADR-72). Los demás motivos (`out_of_scope`, `missing_variable`, `cancelled`) los pone el envío, no la audiencia. */
export type AudienceSkip = 'revoked' | 'excluded' | 'no_phone' | 'no_consent' | 'duplicate';

export interface Classified {
  /** A quienes se les escribiría, en el orden de la audiencia. */
  eligible: AudienceContact[];
  skipped: Array<{ id: string; reason: AudienceSkip }>;
  counts: Record<AudienceSkip, number>;
  /** TODOS los contactos de la audiencia con su estado, en el orden de la audiencia (la lista de destinatarios de la pantalla). */
  states: Array<{ id: string; name: string; phone: string | null; state: AudienceSkip | 'eligible' }>;
}

/**
 * Decide quién entra a la campaña. Función PURA (la prueba que demuestra que un contacto `revoked` jamás recibe nada vive aquí y en el envío). Orden de los motivos —el primero que aplica—:
 * `revoked` (siempre, aunque la persona lo haya incluido a mano) · `excluded` (desmarcado a mano) · `no_phone` · `no_consent` (`unknown` sin que el administrador haya declarado permiso) ·
 * `duplicate` (el mismo teléfono ya entró por otro contacto de la audiencia).
 */
export function classify(contacts: readonly AudienceContact[], opts: { excluded: ReadonlySet<string>; includeUnknownConsent: boolean }): Classified {
  const counts: Record<AudienceSkip, number> = { revoked: 0, excluded: 0, no_phone: 0, no_consent: 0, duplicate: 0 };
  const eligible: AudienceContact[] = [];
  const skipped: Classified['skipped'] = [];
  const states: Classified['states'] = [];
  const seen = new Set<string>();
  for (const c of contacts) {
    const reason: AudienceSkip | null =
      c.consent === 'revoked' ? 'revoked' : opts.excluded.has(c.id) ? 'excluded' : !c.phone ? 'no_phone' : c.consent === 'unknown' && !opts.includeUnknownConsent ? 'no_consent' : seen.has(c.phone) ? 'duplicate' : null;
    states.push({ id: c.id, name: c.name, phone: c.phone, state: reason ?? 'eligible' });
    if (reason) {
      counts[reason] += 1;
      skipped.push({ id: c.id, reason });
      continue;
    }
    seen.add(c.phone!);
    eligible.push(c);
  }
  return { eligible, skipped, counts, states };
}

/**
 * Cuántos mensajes puede mandar la campaña por día (ADR-72 #4, #5, #7): el mínimo entre lo que pidió la campaña, el tope del asesor (si tiene) y el de la conexión. Por WhatsApp oficial el de la
 * conexión es el de la empresa (provisional); por QR es el 70 % del cupo del calentamiento del día (el resto queda para las conversaciones normales). Nunca baja de 1.
 */
export function effectiveDailyCap(input: { mode: 'template' | 'text'; campaignCap: number; advisorCap: number | null; qrWarmupLimit: number; officialCap?: number }): { cap: number; channelCap: number } {
  const channelCap = input.mode === 'text' ? Math.max(1, Math.floor(input.qrWarmupLimit * QR_CAMPAIGN_SHARE)) : (input.officialCap ?? OFFICIAL_DAILY_CAP);
  const cap = Math.max(1, Math.min(input.campaignCap, input.advisorCap ?? Number.POSITIVE_INFINITY, channelCap));
  return { cap, channelCap };
}

/** Cuánto tardaría en enviarse todo (para el «se enviará en N días» y la duración estimada del prototipo): días según el tope diario y segundos del primer día según la pausa. */
export function estimate(eligible: number, cap: number, gapSeconds: number): { days: number; first_day_minutes: number } {
  if (eligible <= 0) return { days: 0, first_day_minutes: 0 };
  const firstDay = Math.min(eligible, cap);
  return { days: Math.ceil(eligible / cap), first_day_minutes: Math.max(1, Math.round((firstDay * gapSeconds) / 60)) };
}
