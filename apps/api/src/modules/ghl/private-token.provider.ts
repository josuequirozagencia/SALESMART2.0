import { GhlError, type GhlCredentials, type GhlProvider } from './ghl.ports';

/**
 * Valor de la cabecera `Version` de la API 2.0 de GHL. SIN CONFIRMAR contra una cuenta real: las fuentes públicas que consulté se contradicen (`2021-07-28`, `2023-02-21`, `v3`), y es lo
 * primero que se valida con la subcuenta del responsable (docs/M7_PLAN.md §5). Es el único lugar donde vive.
 */
export const GHL_API_VERSION = '2021-07-28';
const DEFAULT_BASE = 'https://services.leadconnectorhq.com';
const LOCATION_ID = /^[A-Za-z0-9]{8,64}$/;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Texto de GHL apto para mostrarse: sin saltos de línea, acotado y sin nada parecido a un token (`pit-<uuid>`). */
const safeText = (v: unknown): string =>
  String(Array.isArray(v) ? v.join('; ') : typeof v === 'string' ? v : '')
    .replace(/pit-[0-9a-f-]{20,}/gi, '[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

async function readMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    return safeText(body.message ?? body.error);
  } catch {
    return '';
  }
}

/**
 * Adaptador de GoHighLevel con Private Integration Token (M7.1, ADR-05/ADR-52). Habla solo con la API de GHL: el token va en la cabecera `Authorization` (nunca en la dirección), sin
 * redirecciones, con tiempo máximo, y el Location ID se valida antes de armar la dirección. 401, 403 y 404 (token rechazado, o Location inexistente o sin acceso) son fallos de credenciales
 * y definitivos; 429, 5xx y la red caída se reintentan. El mensaje de todo error es seguro: jamás lleva el token. Probado contra un servidor simulado, NO contra GHL real.
 */
export class PrivateTokenProvider implements GhlProvider {
  readonly kind = 'ghl' as const;
  readonly requiresCredentials = true;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Un contacto de la Location (`limit=1`): exige el permiso de lectura de contactos, que de todos modos hace falta para todo lo demás, y falla si el token no alcanza esa Location.
   * No pide el nombre de la Location (otro permiso), así que `name` es null.
   */
  async verify(credentials: GhlCredentials): Promise<{ name: string | null }> {
    const res = await this.call(`/contacts/?locationId=${this.location(credentials.locationId)}&limit=1`, credentials.accessToken, { method: 'GET' });
    if (!res.ok) throw await this.failure(res);
    return { name: null };
  }

  private location(id: string): string {
    if (!LOCATION_ID.test(id)) throw new GhlError('El Location ID no es válido (solo letras y números)', false, true);
    return id;
  }

  private async call(path: string, token: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}`, version: GHL_API_VERSION, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Red caída, tiempo agotado o redirección: pasajero. El error original podría traer la dirección con datos: no se propaga.
      throw new GhlError('No se pudo contactar a GoHighLevel', true);
    }
  }

  private async failure(res: Response): Promise<GhlError> {
    const text = await readMessage(res);
    const tail = text ? `: ${text}` : '';
    if (res.status === 401 || res.status === 403 || res.status === 404) return new GhlError(`GoHighLevel rechazó el token o no encuentra la Location${tail}`, false, true);
    if (res.status === 429 || res.status >= 500) return new GhlError(`GoHighLevel no pudo atender la llamada ahora${tail}`, true);
    return new GhlError(`GoHighLevel rechazó la solicitud${tail}`, false);
  }
}
