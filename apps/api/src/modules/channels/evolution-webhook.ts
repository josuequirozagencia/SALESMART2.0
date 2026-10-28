import { timingSafeEqual } from 'node:crypto';
import type { DeliveryState, InboundKind, NormalizedInboundEvent, NormalizedMedia, NormalizedMessage, NormalizedReaction, NormalizedStatus } from '../conversations';
import { stripNul } from './meta-webhook';

/**
 * Lector del webhook de Evolution API v2 — WhatsApp por QR, canal NO OFICIAL (M9.6a, ADR-54/ADR-31). Funciones PURAS: sin red ni base de datos. Se escribió contra los eventos REALES que capturó
 * el spike del 2026-10-27 (`spikes/whatsapp-qr/INFORME.md`, Evolution v2.3.7), no contra la documentación. Tolerante: un evento mal formado se descarta y se cuenta, nunca tumba el aviso.
 *
 * Lo aprendido que este lector aplica:
 *  - Evolution manda en CADA evento su `apikey` y la dirección del webhook con su token: aquí se IGNORAN y {@link redactEvolutionPayload} los quita antes de guardar nada.
 *  - Los archivos llegan DENTRO del aviso (`message.base64`): se separan del evento ({@link ParsedEvolution.inlineMedia}) para no guardar megabytes en el registro de avisos.
 *  - Los estados y las reacciones traen un identificador `@lid`, no el teléfono: se correlacionan por el id del mensaje. Un mensaje entrante sin teléfono resoluble se descarta.
 *  - Los estados llegan fuera de orden (el consumidor no los deja retroceder) y `date_time` NO es confiable (viene en hora local etiquetada como UTC): se usa la hora de recepción.
 *  - Los grupos (`@g.us`), los estados de WhatsApp (`status@broadcast`) y lo que escribe el propio chip (`fromMe`) NO son mensajes de un cliente: se ignoran.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const clean = stripNul(v);
  return clean !== '' ? clean : null;
};
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Claves que Evolution repite en los eventos y que son secretos (o que llevan uno): nunca se guardan ni se registran. */
const SECRET_KEYS = new Set(['apikey', 'destination', 'token', 'jwt', 'secret']);
/** El archivo en base64 que viaja dentro del aviso. */
const INLINE_KEYS = new Set(['base64']);

/** Copia del aviso apta para guardarse: sin claves secretas y sin los archivos en base64 (que se guardan aparte). */
export function redactEvolutionPayload<T>(value: T): T {
  if (Array.isArray(value)) return value.map((x: unknown) => redactEvolutionPayload(x)) as T;
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k.toLowerCase())) continue;
      out[k] = INLINE_KEYS.has(k) && typeof v === 'string' ? `[archivo: ${v.length} caracteres]` : redactEvolutionPayload(v);
    }
    return out as T;
  }
  return value;
}

/** Token del webhook (`?token=`) comparado en tiempo constante. Un token vacío nunca autentica. */
export function verifyEvolutionToken(given: string | null | undefined, expected: string): boolean {
  if (!given || expected === '') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Estado de la sesión de WhatsApp según Evolution. `logged_out`: el teléfono cerró la sesión (401) y hay que escanear un QR nuevo; `closed`: se cayó por otra razón; `connecting` NO es una caída. */
export type EvolutionConnectionState = 'open' | 'connecting' | 'logged_out' | 'closed';

export interface EvolutionConnection {
  readonly state: EvolutionConnectionState;
  /** Código que informó Evolution (`statusReason`): 401 = sesión cerrada desde el teléfono, 428 = QR agotado, 200 = normal. */
  readonly reason: number | null;
  /** Teléfono de la sesión en E.164, cuando Evolution lo informa (al abrirse). */
  readonly phone: string | null;
  /** Nombre del perfil de WhatsApp de la sesión. */
  readonly profileName: string | null;
}

export interface ParsedEvolution {
  /** Nombre de la instancia de Evolution (identifica la conexión; hace de «número» del evento normalizado). */
  readonly instance: string | null;
  /** Mensajes, estados y reacciones del aviso (como mucho UN evento: Evolution manda un aviso por evento). */
  readonly events: ReadonlyArray<{ readonly event: NormalizedInboundEvent; readonly raw: Record<string, unknown> }>;
  /** Cambio del estado de la sesión, si el aviso era de conexión. */
  readonly connection: EvolutionConnection | null;
  /** El aviso era un QR nuevo (su contenido NO se conserva) o, si `qrLimit`, Evolution dejó de generar QR y hay que pedir otro. */
  readonly qr: { readonly updated: boolean; readonly limitReached: boolean } | null;
  /** Archivos que llegaron dentro del aviso, por id de mensaje (base64). */
  readonly inlineMedia: ReadonlyMap<string, string>;
  /** Mensajes o estados descartados (grupos, propios del chip, sin teléfono, tipo que no usamos, formato roto). */
  readonly ignored: number;
}

const EMPTY: Omit<ParsedEvolution, 'instance'> = { events: [], connection: null, qr: null, inlineMedia: new Map(), ignored: 0 };

/** «593999999999@s.whatsapp.net» (o con sufijo de dispositivo `:12`) → teléfono E.164; cualquier otro identificador (`@lid`, `@g.us`…) → null. */
export function phoneFromJid(jid: unknown): string | null {
  const s = str(jid);
  const m = s ? /^(\d{6,20})(?::\d+)?@s\.whatsapp\.net$/.exec(s) : null;
  if (!m) return null;
  const phone = `+${m[1]}`;
  return E164_RE.test(phone) ? phone : null;
}

/** Segundos o milisegundos desde 1970 (número, texto o `{low}` de protobuf) → fecha; si no es válida, `fallback`. */
function toDate(v: unknown, fallback: Date): Date {
  const raw = isObj(v) && typeof v['low'] === 'number' ? v['low'] : v;
  const n = typeof raw === 'string' && /^\d{1,14}$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const d = new Date(n < 1e11 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

const MEDIA_MESSAGES = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', documentMessage: 'document', stickerMessage: 'sticker' } as const satisfies Record<string, InboundKind>;

interface Content {
  kind: InboundKind;
  text: string | null;
  media: NormalizedMedia | null;
  extra: Record<string, unknown>;
  /** El archivo en base64, si vino en el aviso. */
  inline: string | null;
}

function contentOf(id: string, message: Record<string, unknown>): Content | 'reaction' {
  if (isObj(message['reactionMessage'])) return 'reaction';
  const inline = str(message['base64']);
  if (str(message['conversation'])) return { kind: 'text', text: str(message['conversation']), media: null, extra: {}, inline: null };
  const ext = isObj(message['extendedTextMessage']) ? message['extendedTextMessage'] : null;
  if (ext && str(ext['text'])) return { kind: 'text', text: str(ext['text']), media: null, extra: {}, inline: null };
  for (const [key, kind] of Object.entries(MEDIA_MESSAGES)) {
    const body = isObj(message[key]) ? message[key] : null;
    if (!body) continue;
    const extra: Record<string, unknown> = {};
    if (typeof body['seconds'] === 'number') extra['seconds'] = body['seconds'];
    if (body['ptt'] === true) extra['voice_note'] = true;
    if (typeof body['pageCount'] === 'number') extra['pages'] = body['pageCount'];
    if (body['isAnimated'] === true) extra['animated'] = true;
    const filename = kind === 'document' ? (str(body['fileName']) ?? str(body['title'])) : null;
    return { kind, text: str(body['caption']), media: { id, mimeType: str(body['mimetype']), filename }, extra, inline };
  }
  const loc = isObj(message['locationMessage']) ? message['locationMessage'] : null;
  if (loc) {
    const lat = typeof loc['degreesLatitude'] === 'number' ? loc['degreesLatitude'] : null;
    const lng = typeof loc['degreesLongitude'] === 'number' ? loc['degreesLongitude'] : null;
    return { kind: 'location', text: null, media: null, extra: lat !== null && lng !== null ? { location: { latitude: lat, longitude: lng, name: str(loc['name']), address: str(loc['address']) } } : {}, inline: null };
  }
  if (isObj(message['contactMessage']) || isObj(message['contactsArrayMessage'])) {
    const many = isObj(message['contactsArrayMessage']) && Array.isArray(message['contactsArrayMessage']['contacts']) ? message['contactsArrayMessage']['contacts'].length : 1;
    return { kind: 'contacts', text: null, media: null, extra: { contacts_count: many }, inline: null };
  }
  const reply = isObj(message['buttonsResponseMessage']) ? message['buttonsResponseMessage'] : isObj(message['listResponseMessage']) ? message['listResponseMessage'] : null;
  if (reply) return { kind: 'interactive', text: str(reply['selectedDisplayText']) ?? str(reply['title']), media: null, extra: {}, inline: null };
  return { kind: 'unsupported', text: null, media: null, extra: {}, inline: null };
}

/** Los estados de Evolution (los de Baileys) → los nuestros. `PENDING` no es un estado de entrega: se ignora. */
const STATUS_MAP: Readonly<Record<string, DeliveryState>> = { SERVER_ACK: 'sent', DELIVERY_ACK: 'delivered', READ: 'read', PLAYED: 'read', ERROR: 'failed' };

function upsert(instance: string, data: Record<string, unknown>, now: Date): Omit<ParsedEvolution, 'instance'> {
  const key = isObj(data['key']) ? data['key'] : null;
  const message = isObj(data['message']) ? data['message'] : null;
  const id = key ? str(key['id']) : null;
  const remote = key ? str(key['remoteJid']) : null;
  if (!key || !message || !id || !remote) return { ...EMPTY, ignored: 1 };
  // Los grupos y los estados de WhatsApp no son una conversación con un cliente; lo que escribe el propio chip tampoco
  if (remote.endsWith('@g.us') || remote === 'status@broadcast' || key['fromMe'] === true) return { ...EMPTY, ignored: 1 };
  const content = contentOf(id, message);
  if (content === 'reaction') {
    const r = message['reactionMessage'] as Record<string, unknown>;
    const target = isObj(r['key']) ? str(r['key']['id']) : null;
    const emoji = typeof r['text'] === 'string' ? stripNul(r['text']).trim() : '';
    if (!target || emoji.length > 32 || /\p{Cc}/u.test(emoji)) return { ...EMPTY, ignored: 1 };
    const reaction: NormalizedReaction = { targetExternalId: target, emoji: emoji === '' ? null : emoji, at: toDate(data['messageTimestamp'], now) };
    return { ...EMPTY, events: [{ event: { phoneNumberId: instance, messages: [], statuses: [], reactions: [reaction] }, raw: redactEvolutionPayload(data) }] };
  }
  // El teléfono sale del identificador de teléfono; si solo hay un `@lid`, se usa la variante `remoteJidAlt` que Evolution da en los chats 1:1
  const from = phoneFromJid(remote) ?? phoneFromJid(key['remoteJidAlt']);
  if (!from) return { ...EMPTY, ignored: 1 };
  const msg: NormalizedMessage = {
    externalId: id,
    from,
    fromRaw: remote,
    profileName: str(data['pushName']),
    kind: content.kind,
    text: content.text,
    media: content.media,
    extra: content.extra,
    sentAt: toDate(data['messageTimestamp'], now),
  };
  const inline = new Map<string, string>();
  if (content.inline && content.media) inline.set(id, content.inline);
  return { ...EMPTY, inlineMedia: inline, events: [{ event: { phoneNumberId: instance, messages: [msg], statuses: [], reactions: [] }, raw: redactEvolutionPayload(data) }] };
}

function update(instance: string, data: Record<string, unknown>, now: Date): Omit<ParsedEvolution, 'instance'> {
  const id = str(data['keyId']) ?? (isObj(data['key']) ? str(data['key']['id']) : null);
  const status = str(data['status']);
  if (!id || !status) return { ...EMPTY, ignored: 1 };
  // Solo importan los estados de lo que NOSOTROS enviamos; el «leído» de los mensajes del cliente (fromMe: false) no es un estado de entrega
  if (data['fromMe'] !== true) return { ...EMPTY, ignored: 1 };
  const state = STATUS_MAP[status.toUpperCase()];
  if (!state) return { ...EMPTY, ignored: status.toUpperCase() === 'PENDING' ? 0 : 1 };
  const s: NormalizedStatus = { externalId: id, state, at: now, error: state === 'failed' ? { code: 'unknown', title: 'El envío falló en WhatsApp' } : null };
  return { ...EMPTY, events: [{ event: { phoneNumberId: instance, messages: [], statuses: [s], reactions: [] }, raw: redactEvolutionPayload(data) }] };
}

function connectionOf(data: Record<string, unknown>): EvolutionConnection | null {
  const raw = str(data['state']);
  if (!raw) return null;
  const reason = typeof data['statusReason'] === 'number' ? data['statusReason'] : null;
  const state: EvolutionConnectionState = raw === 'open' ? 'open' : raw === 'connecting' ? 'connecting' : raw === 'close' || raw === 'closed' || raw === 'refused' ? (reason === 401 ? 'logged_out' : 'closed') : 'closed';
  return { state, reason, phone: phoneFromJid(data['wuid']), profileName: str(data['profileName']) };
}

/**
 * Traduce UN aviso de Evolution (su cuerpo JSON ya autenticado con {@link verifyEvolutionToken}) a lo que entiende el núcleo. Los eventos que no usamos
 * (`send.message`, grupos, contactos, chats…) se ignoran sin error; nunca lanza por un contenido mal formado.
 */
export function parseEvolutionWebhook(body: unknown, now = new Date()): ParsedEvolution {
  if (!isObj(body)) return { instance: null, ...EMPTY, ignored: 1 };
  const instance = str(body['instance']);
  const event = str(body['event'])?.toLowerCase().replaceAll('_', '.') ?? null;
  const data = isObj(body['data']) ? body['data'] : null;
  if (!instance || !event || !data) return { instance, ...EMPTY, ignored: 1 };
  switch (event) {
    case 'messages.upsert':
      return { instance, ...upsert(instance, data, now) };
    case 'messages.update':
      return { instance, ...update(instance, data, now) };
    case 'connection.update':
      return { instance, ...EMPTY, connection: connectionOf(data) };
    case 'qrcode.updated': {
      const limit = typeof data['statusCode'] === 'number' && data['statusCode'] === 500;
      return { instance, ...EMPTY, qr: { updated: isObj(data['qrcode']), limitReached: limit } };
    }
    default:
      return { instance, ...EMPTY }; // send.message, groups.*, contacts.*, chats.*…: no los usamos
  }
}

/** Vuelve a leer un aviso guardado (ya sin secretos ni archivos). */
export const parseStoredEvolution = (raw: Record<string, unknown>, instance: string, event: string, now = new Date()): ParsedEvolution => parseEvolutionWebhook({ instance, event, data: raw }, now);
