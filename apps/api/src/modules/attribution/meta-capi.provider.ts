import { CapiSendError, type CapiCredentials, type CapiEvent, type CapiProvider } from './capi.ports';

export const GRAPH_VERSION = 'v21.0';
const DEFAULT_BASE = 'https://graph.facebook.com';
const DATASET_ID = /^\d{5,30}$/;
const DEFAULT_TIMEOUT_MS = 10_000;

interface GraphError {
  message?: unknown;
  code?: unknown;
  error_subcode?: unknown;
}

/** Códigos de Graph API que significan «credenciales»: token inválido o vencido (190), permiso o acceso denegado (10, 200-299) y recurso inexistente o sin acceso (100/33). */
function isCredentialError(status: number, g: GraphError): boolean {
  const code = typeof g.code === 'number' ? g.code : undefined;
  const sub = typeof g.error_subcode === 'number' ? g.error_subcode : undefined;
  return status === 401 || status === 403 || code === 190 || code === 10 || (code !== undefined && code >= 200 && code <= 299) || (code === 100 && sub === 33) || code === 102;
}
/** Límites de uso y fallos pasajeros de Meta. */
const isRateLimit = (g: GraphError): boolean => typeof g.code === 'number' && [4, 17, 32, 341, 613, 80004].includes(g.code);

async function readError(res: Response): Promise<GraphError> {
  try {
    const body = (await res.json()) as { error?: GraphError };
    return body.error ?? {};
  } catch {
    return {};
  }
}

/** Texto de Meta apto para mostrarse: sin saltos de línea, acotado. Meta no devuelve el token en sus mensajes, pero tampoco se confía: se recorta cualquier cosa parecida a uno. */
const safeText = (v: unknown): string => String(typeof v === 'string' ? v : '').replace(/EAA[A-Za-z0-9]{10,}/g, '[token]').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Adaptador real de la API de Conversiones de Meta (M6.4, ADR-45 #4/#5; F15). Envía UN evento a `POST /{dataset}/events` con el token de la empresa en la cabecera `Authorization`
 * (nunca en la URL). Solo habla con Graph API: sin redirecciones, con tiempo máximo, y el dataset se valida (solo dígitos) antes de armar la dirección. Un fallo de credenciales o
 * de datos es definitivo; los límites de uso, los 5xx y la red caída se reintentan. El mensaje de todo error es seguro: jamás lleva el token.
 */
export class MetaCapiProvider implements CapiProvider {
  readonly kind = 'meta' as const;
  readonly requiresCredentials = true;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(event: CapiEvent, credentials: CapiCredentials): Promise<void> {
    const url = this.urlFor(credentials.datasetId, '/events');
    const body: Record<string, unknown> = { data: [event.payload] };
    if (credentials.testEventCode) body['test_event_code'] = credentials.testEventCode;
    const res = await this.call(url, credentials.accessToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw await this.failure(res);
    let received: unknown;
    try {
      received = ((await res.json()) as { events_received?: unknown }).events_received;
    } catch {
      throw new CapiSendError('Meta respondió algo que no se entiende', true);
    }
    if (typeof received === 'number' && received < 1) throw new CapiSendError('Meta no recibió el evento (events_received = 0)', false);
  }

  async verify(credentials: CapiCredentials): Promise<{ name: string | null }> {
    const url = this.urlFor(credentials.datasetId, '?fields=id,name');
    const res = await this.call(url, credentials.accessToken, { method: 'GET' });
    if (!res.ok) throw await this.failure(res);
    try {
      const body = (await res.json()) as { id?: unknown; name?: unknown };
      if (typeof body.id === 'string' && body.id !== credentials.datasetId) throw new CapiSendError('Meta respondió por otro dataset', false, true);
      return { name: typeof body.name === 'string' ? safeText(body.name) : null };
    } catch (e) {
      if (e instanceof CapiSendError) throw e;
      throw new CapiSendError('Meta respondió algo que no se entiende', true);
    }
  }

  private urlFor(datasetId: string, suffix: string): string {
    if (!DATASET_ID.test(datasetId)) throw new CapiSendError('El identificador del dataset no es válido (solo dígitos)', false, true);
    return `${this.baseUrl}/${GRAPH_VERSION}/${datasetId}${suffix}`;
  }

  private async call(url: string, token: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      // Red caída, tiempo agotado o redirección: pasajero. El error original podría traer la dirección con datos: no se propaga.
      throw new CapiSendError('No se pudo contactar a Meta', true);
    }
  }

  private async failure(res: Response): Promise<CapiSendError> {
    const g = await readError(res);
    const text = safeText(g.message);
    if (isCredentialError(res.status, g)) return new CapiSendError(`Meta rechazó las credenciales${text ? `: ${text}` : ''}`, false, true);
    if (res.status === 429 || res.status >= 500 || isRateLimit(g)) return new CapiSendError(`Meta no pudo atender el envío ahora${text ? `: ${text}` : ''}`, true);
    return new CapiSendError(`Meta rechazó el evento${text ? `: ${text}` : ''}`, false);
  }
}
