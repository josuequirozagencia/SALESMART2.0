import { normalizeMetaTemplate } from './meta-templates';
import { parseMetaWebhook, verifyMetaSignature, wrapMetaValue } from './meta-webhook';
import { WhatsAppProviderError, type NormalizedTemplate, type NumberInfo, type ParsedWebhook, type SendTemplateInput, type SendTextInput, type SentMessage, type WhatsAppCredentials, type WhatsAppProvider } from './whatsapp.port';

export interface MetaCloudOptions {
  /** Origen de la Graph API (se cambia en las pruebas por un servidor simulado). */
  readonly baseUrl?: string;
  /** Versión de la Graph API. */
  readonly version?: string;
  /** `fetch` inyectable (pruebas). */
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

const ID_RE = /^[0-9]{5,25}$/;
/** Destino de un mensaje: E.164 sin «+» (8 a 15 dígitos). */
const TO_RE = /^[0-9]{8,15}$/;
/** Largo máximo del texto de un mensaje de WhatsApp. */
const MAX_TEXT = 4096;
/** Códigos de error de la Cloud API que significan «ese destinatario no puede recibir»: número inválido o sin WhatsApp, fuera de la lista de prueba, no registrado. */
const RECIPIENT_CODES: ReadonlySet<number> = new Set([131026, 131030, 131021, 133010]);
/** Códigos de límite de envíos (por número, por par o general). */
const RATE_CODES: ReadonlySet<number> = new Set([130429, 131056, 80007, 4]);
/** Plantilla que ya no existe (132001), en pausa (132015) o deshabilitada (132016). */
const TEMPLATE_GONE_CODES: ReadonlySet<number> = new Set([132001, 132015, 132016]);
/** Variables que no coinciden con la plantilla: cantidad (132000), texto demasiado largo (132005), política de formato (132007) o formato del parámetro (132012). */
const TEMPLATE_PARAM_CODES: ReadonlySet<number> = new Set([132000, 132005, 132007, 132012]);
/** Páginas de 100 plantillas que se leen como máximo por sincronización (2000 plantillas). */
const MAX_TEMPLATE_PAGES = 20;
/** Nombre de plantilla e idioma tal como los acepta la Cloud API. */
const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANG_RE = /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/;
/** Cursor de paginación que devuelve Meta: se reenvía tal cual, pero solo si tiene forma de cursor (nunca se sigue una URL que venga en la respuesta). */
const CURSOR_RE = /^[A-Za-z0-9+/=_-]{1,500}$/;

/**
 * Adaptador de WhatsApp Cloud API de Meta (ADR-02/50). Habla con la Graph API por `fetch` y traduce sus respuestas a los códigos de nuestro puerto.
 * Nunca incluye el token en un error ni en un registro. **Probado solo contra respuestas simuladas** hasta que haya credenciales reales de Meta.
 */
export class MetaCloudProvider implements WhatsAppProvider {
  readonly name = 'meta_cloud' as const;
  private readonly base: string;
  private readonly version: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: MetaCloudOptions = {}) {
    this.base = (opts.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
    this.version = opts.version ?? 'v21.0';
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
    return verifyMetaSignature(rawBody, signature, appSecret);
  }

  parseWebhook(body: unknown, now?: Date): ParsedWebhook {
    return parseMetaWebhook(body, now);
  }

  parseStored(raw: Record<string, unknown>, now?: Date): ParsedWebhook {
    return parseMetaWebhook(wrapMetaValue(raw), now);
  }

  async describeNumber(credentials: WhatsAppCredentials, phoneNumberId: string): Promise<NumberInfo> {
    // El id va en la ruta: solo dígitos, nunca algo que cambie la URL
    if (!ID_RE.test(phoneNumberId)) throw new WhatsAppProviderError('number_not_found', 'El identificador del número no es válido');
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/${this.version}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
        method: 'GET',
        headers: { authorization: `Bearer ${credentials.accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new WhatsAppProviderError('unavailable', 'No pudimos conectar con Meta');
    }
    const body = (await res.json().catch(() => null)) as { display_phone_number?: unknown; verified_name?: unknown; error?: { code?: unknown } } | null;
    if (res.ok) {
      const display = body?.display_phone_number;
      if (typeof display !== 'string' || display === '') throw new WhatsAppProviderError('unavailable', 'Meta respondió con un formato inesperado');
      return { displayPhone: display, verifiedName: typeof body?.verified_name === 'string' && body.verified_name !== '' ? body.verified_name : null };
    }
    const code = typeof body?.error?.code === 'number' ? body.error.code : null;
    // 190 = token inválido o vencido; 401 sin código también es credencial rechazada
    if (res.status === 401 || code === 190) throw new WhatsAppProviderError('invalid_token', 'Meta rechazó el token');
    // 100 = el objeto no existe o el token no tiene permiso sobre él; 404 también
    if (res.status === 404 || code === 100) throw new WhatsAppProviderError('number_not_found', 'Meta no encontró ese número con este token');
    throw new WhatsAppProviderError('unavailable', 'Meta no pudo atender la consulta');
  }

  async sendText(credentials: WhatsAppCredentials, phoneNumberId: string, input: SendTextInput): Promise<SentMessage> {
    if (!ID_RE.test(phoneNumberId)) throw new WhatsAppProviderError('number_not_found', 'El identificador del número no es válido');
    // El destino va en el cuerpo: solo dígitos (E.164 sin «+»). Un texto vacío o más largo que el máximo de WhatsApp ni siquiera sale a la red
    if (!TO_RE.test(input.to)) throw new WhatsAppProviderError('recipient_invalid', 'El número de destino no es válido');
    if (input.text === '' || input.text.length > MAX_TEXT) throw new WhatsAppProviderError('rejected', 'El texto no es válido para WhatsApp');
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/${this.version}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credentials.accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: input.to, type: 'text', text: { preview_url: false, body: input.text } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new WhatsAppProviderError('unavailable', 'No pudimos conectar con Meta');
    }
    return this.sentOrThrow(res);
  }

  /**
   * Todas las plantillas de la cuenta de WhatsApp Business, de cualquier estado. Se pagina con el cursor `after` de Meta (nunca se sigue una URL de la respuesta) hasta
   * `MAX_TEMPLATE_PAGES`; una entrada que no se entiende se descarta.
   */
  async listTemplates(credentials: WhatsAppCredentials, wabaId: string): Promise<readonly NormalizedTemplate[]> {
    if (!ID_RE.test(wabaId)) throw new WhatsAppProviderError('number_not_found', 'El identificador de la cuenta de WhatsApp Business no es válido');
    const out: NormalizedTemplate[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_TEMPLATE_PAGES; page++) {
      const qs = new URLSearchParams({ fields: 'id,name,language,status,category,parameter_format,components,rejected_reason', limit: '100' });
      if (after) qs.set('after', after);
      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}/${this.version}/${wabaId}/message_templates?${qs.toString()}`, {
          method: 'GET',
          headers: { authorization: `Bearer ${credentials.accessToken}`, accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new WhatsAppProviderError('unavailable', 'No pudimos conectar con Meta');
      }
      const body = (await res.json().catch(() => null)) as { data?: unknown; paging?: { cursors?: { after?: unknown }; next?: unknown }; error?: { code?: unknown } } | null;
      if (!res.ok) {
        const code = typeof body?.error?.code === 'number' ? body.error.code : null;
        if (res.status === 401 || code === 190) throw new WhatsAppProviderError('invalid_token', 'Meta rechazó el token');
        if (res.status === 404 || code === 100) throw new WhatsAppProviderError('number_not_found', 'Meta no encontró la cuenta de WhatsApp Business con este token');
        if (res.status === 429 || (code !== null && RATE_CODES.has(code))) throw new WhatsAppProviderError('rate_limited', 'Meta limitó las consultas por ahora');
        if (res.status >= 500) throw new WhatsAppProviderError('unavailable', 'Meta no pudo atender la consulta');
        throw new WhatsAppProviderError('rejected', code === null ? 'Meta rechazó la consulta' : `Meta rechazó la consulta (código ${code})`);
      }
      if (!Array.isArray(body?.data)) throw new WhatsAppProviderError('unavailable', 'Meta respondió con un formato inesperado');
      for (const raw of body.data) {
        const t = normalizeMetaTemplate(raw);
        if (t) out.push(t);
      }
      const next = body.paging?.cursors?.after;
      if (!body.paging?.next || typeof next !== 'string' || !CURSOR_RE.test(next)) break;
      after = next;
    }
    return out;
  }

  async sendTemplate(credentials: WhatsAppCredentials, phoneNumberId: string, input: SendTemplateInput): Promise<SentMessage> {
    if (!ID_RE.test(phoneNumberId)) throw new WhatsAppProviderError('number_not_found', 'El identificador del número no es válido');
    if (!TO_RE.test(input.to)) throw new WhatsAppProviderError('recipient_invalid', 'El número de destino no es válido');
    if (!TEMPLATE_NAME_RE.test(input.name) || !TEMPLATE_LANG_RE.test(input.language)) throw new WhatsAppProviderError('template_unavailable', 'El nombre o el idioma de la plantilla no son válidos');
    const components = input.components.map((c) => ({
      type: c.type,
      ...(c.subType !== null ? { sub_type: c.subType, index: String(c.index ?? 0) } : {}),
      parameters: c.parameters.map((p) => ({ type: 'text', text: p.text, ...(p.name !== null ? { parameter_name: p.name } : {}) })),
    }));
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/${this.version}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credentials.accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: input.to, type: 'template', template: { name: input.name, language: { code: input.language }, ...(components.length > 0 ? { components } : {}) } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new WhatsAppProviderError('unavailable', 'No pudimos conectar con Meta');
    }
    return this.sentOrThrow(res);
  }

  /** La respuesta de un envío (texto o plantilla): el identificador del mensaje, o el error traducido a un código nuestro. */
  private async sentOrThrow(res: Response): Promise<SentMessage> {
    const body = (await res.json().catch(() => null)) as { messages?: Array<{ id?: unknown }>; error?: { code?: unknown } } | null;
    if (res.ok) {
      const id = body?.messages?.[0]?.id;
      if (typeof id !== 'string' || id === '') throw new WhatsAppProviderError('unavailable', 'Meta respondió con un formato inesperado');
      return { externalId: id };
    }
    const code = typeof body?.error?.code === 'number' ? body.error.code : null;
    // Los mensajes de error NUNCA llevan el texto enviado ni el teléfono: solo nuestra explicación y, si acaso, el código numérico de Meta
    if (res.status === 401 || code === 190) throw new WhatsAppProviderError('invalid_token', 'Meta rechazó el token');
    if (code === 131047) throw new WhatsAppProviderError('window_closed', 'Pasaron más de 24 horas desde el último mensaje del cliente: Meta solo admite una plantilla aprobada');
    if (code !== null && RECIPIENT_CODES.has(code)) throw new WhatsAppProviderError('recipient_invalid', `Meta no pudo entregar el mensaje a ese número (código ${code})`);
    if (code !== null && TEMPLATE_GONE_CODES.has(code)) throw new WhatsAppProviderError('template_unavailable', `La plantilla ya no está disponible en Meta (código ${code})`);
    if (code !== null && TEMPLATE_PARAM_CODES.has(code)) throw new WhatsAppProviderError('template_params', `Meta no aceptó los datos de la plantilla (código ${code})`);
    if (res.status === 429 || (code !== null && RATE_CODES.has(code))) throw new WhatsAppProviderError('rate_limited', 'Meta limitó los envíos de este número por ahora');
    if (res.status === 404 || code === 100) throw new WhatsAppProviderError('number_not_found', 'Meta no encontró el número de la conexión con este token');
    if (res.status >= 500) throw new WhatsAppProviderError('unavailable', 'Meta no pudo atender el envío');
    throw new WhatsAppProviderError('rejected', code === null ? 'Meta rechazó el mensaje' : `Meta rechazó el mensaje (código ${code})`);
  }
}
