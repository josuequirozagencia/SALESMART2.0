import { GRAPH_VERSION } from '../../meta/graph-version';
import { CapiSendError, type AdNames, type CapiCredentials, type CapiEvent, type CapiProvider } from './capi.ports';

export { GRAPH_VERSION };
const DEFAULT_BASE = 'https://graph.facebook.com';
const DATASET_ID = /^\d{5,30}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Cuántos anuncios se piden a la vez a la Marketing API. */
const AD_LOOKUP_CONCURRENCY = 5;
type AdNode = { name?: unknown; adset?: { id?: unknown; name?: unknown }; campaign?: { id?: unknown; name?: unknown } };
/** Por qué Meta no dio UN anuncio: `missing` = no existe o no se puede leer; `blocked` = falta permiso u otro rechazo de la petición. */
interface AdFailure { failure: 'missing' | 'blocked'; error: CapiSendError }

interface GraphError {
  message?: unknown;
  code?: unknown;
  error_subcode?: unknown;
  error_user_title?: unknown;
  error_user_msg?: unknown;
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

  /**
   * Un `GET /{anuncio}` por anuncio, de a pocos a la vez: Meta retiró la consulta conjunta `GET /?ids=` (octubre de 2026, todas las versiones).
   * Un token inválido o un fallo pasajero cortan todo. Lo que falla en un solo anuncio lo deja en `null`, salvo que NINGUNO se haya podido leer por algo que apunta al token
   * (sin permiso, otro rechazo, o todos «no existe» siendo varios): entonces se lanza, para no marcar como borrados anuncios que solo no se pueden leer.
   */
  async lookupAds(adIds: readonly string[], credentials: CapiCredentials): Promise<Record<string, AdNames | null>> {
    const out: Record<string, AdNames | null> = Object.fromEntries(adIds.map((x) => [x, null]));
    const ids = [...new Set(adIds)].filter((x) => /^\d{5,30}$/.test(x)).slice(0, 50);
    const failures: AdFailure[] = [];
    let found = 0;
    for (let i = 0; i < ids.length; i += AD_LOOKUP_CONCURRENCY) {
      const chunk = ids.slice(i, i + AD_LOOKUP_CONCURRENCY);
      const results = await Promise.all(chunk.map((id) => this.lookupAd(id, credentials.accessToken)));
      results.forEach((r, n) => {
        if ('names' in r) {
          out[chunk[n]!] = r.names;
          found += 1;
        } else failures.push(r);
      });
    }
    if (found === 0) {
      const blocking = failures.find((f) => f.failure === 'blocked') ?? (failures.length > 1 ? failures[0] : undefined);
      if (blocking) throw blocking.error;
    }
    return out;
  }

  private async lookupAd(id: string, token: string): Promise<{ names: AdNames } | AdFailure> {
    const res = await this.call(`${this.baseUrl}/${GRAPH_VERSION}/${id}?fields=name,adset{id,name},campaign{id,name}`, token, { method: 'GET' });
    if (!res.ok) {
      const g = await readError(res);
      const error = this.errorFor(res.status, g);
      const tokenInvalid = res.status === 401 || g.code === 190 || g.code === 102;
      if (error.retryable || tokenInvalid) throw error;
      const missing = res.status === 404 || (g.code === 100 && g.error_subcode === 33);
      return { failure: missing ? 'missing' : 'blocked', error };
    }
    let a: AdNode | null;
    try {
      a = (await res.json()) as AdNode | null;
    } catch {
      throw new CapiSendError('Meta respondió algo que no se entiende', true);
    }
    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? safeText(v) : null);
    return { names: { adName: str(a?.name), adsetId: str(a?.adset?.id), adsetName: str(a?.adset?.name), campaignId: str(a?.campaign?.id), campaignName: str(a?.campaign?.name) } };
  }

  async ensureMessagingDataset(wabaId: string, credentials: CapiCredentials): Promise<{ datasetId: string }> {
    if (!DATASET_ID.test(wabaId)) throw new CapiSendError('El identificador de la cuenta de WhatsApp Business no es válido (solo dígitos)', false, true);
    const res = await this.call(`${this.baseUrl}/${GRAPH_VERSION}/${wabaId}/dataset`, credentials.accessToken, { method: 'POST' });
    if (!res.ok) throw await this.failure(res);
    let id: unknown;
    try {
      id = ((await res.json()) as { id?: unknown }).id;
    } catch {
      throw new CapiSendError('Meta respondió algo que no se entiende', true);
    }
    if (typeof id !== 'string' || !DATASET_ID.test(id)) throw new CapiSendError('Meta no devolvió el dataset de mensajes', false);
    return { datasetId: id };
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
    return this.errorFor(res.status, await readError(res));
  }

  private errorFor(status: number, g: GraphError): CapiSendError {
    // «Invalid parameter» no dice nada: Meta explica el motivo en el título y el mensaje para el usuario, y en el subcódigo
    const title = safeText(g.error_user_title);
    const detail = safeText(g.error_user_msg);
    const sub = typeof g.error_subcode === 'number' ? ` (${g.error_subcode})` : '';
    const text = [safeText(g.message), [title, detail].filter(Boolean).join('. ') + sub].filter((x) => x !== '' && x !== sub).join(' — ').slice(0, 290);
    if (isCredentialError(status, g)) return new CapiSendError(`Meta rechazó las credenciales${text ? `: ${text}` : ''}`, false, true);
    if (status === 429 || status >= 500 || isRateLimit(g)) return new CapiSendError(`Meta no pudo atender el envío ahora${text ? `: ${text}` : ''}`, true);
    return new CapiSendError(`Meta rechazó el evento${text ? `: ${text}` : ''}`, false);
  }
}
