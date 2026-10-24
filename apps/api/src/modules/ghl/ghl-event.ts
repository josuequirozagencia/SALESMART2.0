import { createHash } from 'node:crypto';

/**
 * Contrato de los avisos que el Workflow de GoHighLevel manda a Sales Smart (M7.2, ADR-52). GHL no documenta con certeza el cuerpo de la acción «Webhook» (docs/M7_PLAN.md §5), así que el
 * contrato es PROPIO y tolerante: se lee del nivel superior y, si no está, de `customData` o de `contact`; los campos que no conocemos se IGNORAN (GHL manda muchos más) y nunca se guardan.
 *
 *   event        'contact' (por omisión) | 'message_in' (reservado para M7.4)
 *   contact_id   identificador del contacto en GHL (obligatorio)       · también `contactId` o `contact.id`
 *   full_name    nombre (o `name`, o `first_name` + `last_name`)
 *   phone        teléfono en formato internacional (+593…)
 *   email        correo
 *   tags         etiquetas del contacto: lista o texto separado por comas
 *   location.id  Location de GHL (si viene, debe ser la de la conexión)  · también `location_id`
 *   event_id     identificador único del aviso, para no procesarlo dos veces (opcional)
 */
export type GhlEventType = 'contact' | 'message_in';
export const GHL_EVENT_TYPES: readonly GhlEventType[] = ['contact', 'message_in'];

export interface GhlEventPayload {
  type: GhlEventType;
  ghlContactId: string;
  name: string | null;
  /** E.164, o null si no vino o no tenía formato internacional. */
  phone: string | null;
  /** Vino un teléfono pero no se pudo entender (para explicarlo en el panel). */
  phoneInvalid: boolean;
  email: string | null;
  tags: string[];
  locationId: string | null;
  eventId: string | null;
}

export interface GhlEventIssue {
  path: string;
  code: string;
  message: string;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+[.][^\s@]{2,}$/;
const CONTROL = /\p{Cc}/gu;
export const MAX_TAGS = 50;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Texto o número como texto; cualquier otra cosa (objetos, listas, booleanos) no cuenta. */
const text = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
  return s === null ? null : s.replace(CONTROL, ' ').trim() || null;
};
const first = (...vs: unknown[]): string | null => {
  for (const v of vs) {
    const t = text(v);
    if (t !== null) return t;
  }
  return null;
};

function tagList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out: string[] = [];
  for (const t of raw) {
    const s = text(t)?.slice(0, 100);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Valida y normaliza el cuerpo de un aviso. Devuelve los problemas del contrato (nada de datos personales en ellos) o el aviso listo para guardar. */
export function normalizeGhlPayload(body: unknown): { ok: true; event: GhlEventPayload } | { ok: false; issues: GhlEventIssue[] } {
  if (!isObject(body)) return { ok: false, issues: [{ path: 'body', code: 'invalid_type', message: 'El cuerpo debe ser un objeto JSON' }] };
  const custom = isObject(body['customData']) ? body['customData'] : {};
  const contact = isObject(body['contact']) ? body['contact'] : {};
  const location = isObject(body['location']) ? body['location'] : {};
  // El nivel superior manda; `customData` completa lo que falte
  const top = (k: string): unknown => (body[k] !== undefined && body[k] !== null && body[k] !== '' ? body[k] : custom[k]);

  const issues: GhlEventIssue[] = [];
  const rawType = text(top('event')) ?? 'contact';
  if (!(GHL_EVENT_TYPES as readonly string[]).includes(rawType)) issues.push({ path: 'event', code: 'invalid_enum', message: `El tipo de aviso debe ser: ${GHL_EVENT_TYPES.join(', ')}` });
  const ghlContactId = first(top('contact_id'), top('contactId'), contact['id']);
  if (!ghlContactId) issues.push({ path: 'contact_id', code: 'required', message: 'Falta el identificador del contacto de GoHighLevel (contact_id)' });
  else if (ghlContactId.length > 100) issues.push({ path: 'contact_id', code: 'too_long', message: 'El identificador del contacto es demasiado largo' });
  const eventId = first(top('event_id'));
  if (eventId && eventId.length > 100) issues.push({ path: 'event_id', code: 'too_long', message: 'event_id es demasiado largo (máximo 100)' });
  if (issues.length > 0) return { ok: false, issues };

  const parts = [first(top('first_name'), contact['firstName'], contact['first_name']), first(top('last_name'), contact['lastName'], contact['last_name'])].filter((x): x is string => x !== null);
  const name = (first(top('full_name'), top('name'), top('contact_name'), contact['name'], contact['full_name']) ?? (parts.length > 0 ? parts.join(' ') : null))?.slice(0, 200).trim() || null;

  const phoneRaw = first(top('phone'), contact['phone']);
  const phone = phoneRaw ? phoneRaw.replace(/[\s().-]/g, '') : null;
  const phoneOk = phone !== null && E164.test(phone);
  const emailRaw = first(top('email'), contact['email'])?.toLowerCase() ?? null;
  const email = emailRaw && emailRaw.length <= 254 && EMAIL.test(emailRaw) ? emailRaw : null;
  const locationId = first(location['id'], top('location_id'), top('locationId'));

  return {
    ok: true,
    event: {
      type: rawType as GhlEventType,
      ghlContactId: ghlContactId!,
      name,
      phone: phoneOk ? phone : null,
      phoneInvalid: phoneRaw !== null && !phoneOk,
      email,
      tags: tagList(top('tags') ?? contact['tags']),
      locationId,
      eventId,
    },
  };
}

/** Ventana (ms) dentro de la cual dos avisos idénticos sin `event_id` se toman por el mismo (reintentos del Workflow). */
export const DEDUPE_WINDOW_MS = 10 * 60_000;

/** Clave para no procesar dos veces el mismo aviso: el `event_id` que mande el Workflow o, si no, la huella del contenido dentro de la ventana de 10 minutos. */
export function dedupeKeyOf(e: GhlEventPayload, now: Date): string {
  if (e.eventId) return `id:${e.eventId}`;
  const canonical = JSON.stringify([e.type, e.ghlContactId, e.name, e.phone, e.email, [...e.tags].sort(), Math.floor(now.getTime() / DEDUPE_WINDOW_MS)]);
  return `h:${createHash('sha256').update(canonical).digest('hex')}`;
}
