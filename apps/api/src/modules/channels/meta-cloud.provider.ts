import { parseMetaWebhook, verifyMetaSignature, wrapMetaValue } from './meta-webhook';
import { WhatsAppProviderError, type NumberInfo, type ParsedWebhook, type WhatsAppCredentials, type WhatsAppProvider } from './whatsapp.port';

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
}
