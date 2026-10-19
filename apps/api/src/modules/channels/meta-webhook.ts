import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundKind, NormalizedInboundEvent, NormalizedMedia, NormalizedMessage, NormalizedReaction, NormalizedStatus } from '../conversations';
import type { ParsedWebhook } from './whatsapp.port';

/**
 * Formato del webhook de WhatsApp Cloud API de Meta (M5.2, ADR-50). Funciones PURAS: sin red ni base de datos. El adaptador de Meta y el fake las comparten, y
 * el contract test las ejercita con las mismas cargas. Tolerante: un mensaje mal formado se descarta (y se cuenta), nunca tumba el aviso entero.
 */

const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/i;
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Firma `X-Hub-Signature-256`: HMAC-SHA256 del cuerpo EXACTO con el secreto de la aplicación de Meta. Comparación en tiempo constante. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  const m = header ? SIGNATURE_RE.exec(header.trim()) : null;
  if (!m || appSecret === '') return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(m[1]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** PostgreSQL no admite el carácter NUL (U+0000) en `text` ni `jsonb`: se quita de todo texto que viene de fuera. */
export const stripNul = (s: string): string => s.replaceAll('\u0000', '');
/** Copia de un valor JSON sin NUL en ningún texto (ni en las claves): lo que se guarda en `jsonb`. */
export function deepStripNul<T>(v: T): T {
  if (typeof v === 'string') return stripNul(v) as T;
  if (Array.isArray(v)) return v.map((x: unknown) => deepStripNul(x)) as T;
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [stripNul(k), deepStripNul(x)])) as T;
  return v;
}
const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const clean = stripNul(v);
  return clean !== '' ? clean : null;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Segundos desde 1970 (texto o número) → fecha; si no es válida, `fallback`. */
function toDate(v: unknown, fallback: Date): Date {
  const n = typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : fallback;
}

const MEDIA_KINDS = ['image', 'audio', 'video', 'document', 'sticker'] as const;

interface Parsed {
  message: NormalizedMessage | null;
  /** true = es un mensaje que no se guarda a propósito (avisos del sistema): no cuenta como descartado por error. */
  skipped: boolean;
}

function parseMessage(m: Record<string, unknown>, names: ReadonlyMap<string, string>, now: Date): Parsed {
  const id = str(m['id']);
  const from = str(m['from']);
  const type = str(m['type']);
  if (!id || !from || !type) return { message: null, skipped: false };
  if (type === 'system') return { message: null, skipped: true };
  const phone = `+${from.replace(/\D/g, '')}`;
  if (!E164_RE.test(phone)) return { message: null, skipped: false };

  let kind: InboundKind = 'unsupported';
  let text: string | null = null;
  let media: NormalizedMedia | null = null;
  const extra: Record<string, unknown> = {};

  if (type === 'text') {
    kind = 'text';
    text = isObj(m['text']) ? str(m['text']['body']) : null;
  } else if ((MEDIA_KINDS as readonly string[]).includes(type)) {
    kind = type as InboundKind;
    const body = isObj(m[type]) ? m[type] : {};
    const mediaId = str(body['id']);
    if (mediaId) media = { id: mediaId, mimeType: str(body['mime_type']), filename: type === 'document' ? str(body['filename']) : null };
    text = str(body['caption']);
  } else if (type === 'location') {
    kind = 'location';
    const l = isObj(m['location']) ? m['location'] : {};
    const lat = typeof l['latitude'] === 'number' ? l['latitude'] : null;
    const lng = typeof l['longitude'] === 'number' ? l['longitude'] : null;
    if (lat !== null && lng !== null) extra['location'] = { latitude: lat, longitude: lng, name: str(l['name']), address: str(l['address']) };
  } else if (type === 'contacts') {
    kind = 'contacts';
    extra['contacts_count'] = arr(m['contacts']).length;
  } else if (type === 'interactive') {
    kind = 'interactive';
    const i = isObj(m['interactive']) ? m['interactive'] : {};
    const reply = isObj(i['button_reply']) ? i['button_reply'] : isObj(i['list_reply']) ? i['list_reply'] : {};
    text = str(reply['title']);
  } else if (type === 'button') {
    kind = 'button';
    text = isObj(m['button']) ? str(m['button']['text']) : null;
  }
  // Cualquier otro tipo (pedidos, tipos nuevos, `unsupported`) llega como `unsupported`

  return {
    skipped: false,
    message: { externalId: id, from: phone, fromRaw: from, profileName: names.get(from) ?? null, kind, text, media, extra, sentAt: toDate(m['timestamp'], now) },
  };
}

/** Largo máximo de una reacción (una secuencia de emoji con varios modificadores llega a ~25 unidades). */
const MAX_EMOJI = 32;

/** Reacción de un cliente: el emoji, o ninguno si quitó la suya. Sin el mensaje al que reacciona, o con un emoji inválido (control, demasiado largo), se descarta. */
function parseReaction(m: Record<string, unknown>, now: Date): NormalizedReaction | null {
  const r = isObj(m['reaction']) ? m['reaction'] : null;
  const target = r ? str(r['message_id']) : null;
  if (!r || !target) return null;
  const raw = typeof r['emoji'] === 'string' ? stripNul(r['emoji']).trim() : '';
  if (raw.length > MAX_EMOJI || /\p{Cc}/u.test(raw)) return null;
  return { targetExternalId: target, emoji: raw === '' ? null : raw, at: toDate(m['timestamp'], now) };
}

function parseStatus(s: Record<string, unknown>, now: Date): NormalizedStatus | null {
  const id = str(s['id']);
  const state = str(s['status']);
  if (!id || (state !== 'sent' && state !== 'delivered' && state !== 'read' && state !== 'failed')) return null;
  let error: NormalizedStatus['error'] = null;
  if (state === 'failed') {
    const e = arr(s['errors']).find(isObj);
    const code = e ? (typeof e['code'] === 'number' || typeof e['code'] === 'string' ? String(e['code']) : null) : null;
    error = { code: code ?? 'unknown', title: ((e && str(e['title'])) ?? 'Error del proveedor').slice(0, 200) };
  }
  return { externalId: id, state, at: toDate(s['timestamp'], now), error };
}

/**
 * Convierte el cuerpo de un webhook de Meta en eventos normalizados, uno por cada aviso `value` de un número (`metadata.phone_number_id`). Lo que no es de
 * WhatsApp, o no trae número, se ignora.
 */
export function parseMetaWebhook(body: unknown, now = new Date()): ParsedWebhook {
  const events: Array<{ event: NormalizedInboundEvent; raw: Record<string, unknown> }> = [];
  let ignored = 0;
  if (!isObj(body) || body['object'] !== 'whatsapp_business_account') return { events, ignored };
  for (const entry of arr(body['entry'])) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry['changes'])) {
      if (!isObj(change) || change['field'] !== 'messages' || !isObj(change['value'])) continue;
      const value = change['value'];
      const phoneNumberId = isObj(value['metadata']) ? str(value['metadata']['phone_number_id']) : null;
      if (!phoneNumberId) continue;
      const names = new Map<string, string>();
      for (const c of arr(value['contacts'])) {
        if (isObj(c) && str(c['wa_id']) && isObj(c['profile']) && str(c['profile']['name'])) names.set(str(c['wa_id'])!, str(c['profile']['name'])!);
      }
      const messages: NormalizedMessage[] = [];
      const reactions: NormalizedReaction[] = [];
      for (const m of arr(value['messages'])) {
        if (isObj(m) && str(m['type']) === 'reaction') {
          const r = parseReaction(m, now);
          if (r) reactions.push(r);
          else ignored += 1;
          continue;
        }
        const p = isObj(m) ? parseMessage(m, names, now) : { message: null, skipped: false };
        if (p.message) messages.push(p.message);
        else if (!p.skipped) ignored += 1;
      }
      const statuses: NormalizedStatus[] = [];
      for (const s of arr(value['statuses'])) {
        const p = isObj(s) ? parseStatus(s, now) : null;
        if (p) statuses.push(p);
        else ignored += 1;
      }
      events.push({ event: { phoneNumberId, messages, statuses, reactions }, raw: value });
    }
  }
  return { events, ignored };
}

/** Envoltura mínima para reprocesar un `value` guardado con el mismo lector. */
export const wrapMetaValue = (value: Record<string, unknown>): Record<string, unknown> => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value }] }] });
