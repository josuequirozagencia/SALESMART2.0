/**
 * Cliente HTTP de la API (/v1). Reglas de seguridad (ADR-26):
 *  - El access token vive SOLO en memoria (nunca en localStorage/sessionStorage). El refresh viaja en cookie HttpOnly.
 *  - El refresh es de UN solo uso y sin ventana de gracia: dos refrescos simultáneos revocan la sesión. Por eso hay un
 *    único refresh en vuelo (promesa compartida) y, entre pestañas, un candado (Web Locks) que serializa el uso de la cookie.
 *  - Los mensajes de error del servidor se traducen en lib/errors.ts; aquí solo se normalizan.
 */
export const CSRF_HEADER = 'x-requested-by';
export const CSRF_VALUE = 'sales-smart-web';

export interface ErrorDetail { path: string; code: string; message: string }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
    readonly details: readonly ErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
export const tokens = {
  get: (): string | null => accessToken,
  set: (t: string | null): void => { accessToken = t; },
};

type Listener = () => void;
const lostListeners = new Set<Listener>();
/** Se llama cuando la sesión ya no se puede recuperar (refresh rechazado): la UI vuelve al login. */
export function onSessionLost(fn: Listener): () => void {
  lostListeners.add(fn);
  return () => { lostListeners.delete(fn); };
}

let inflightRefresh: Promise<boolean> | null = null;

/** Rota la sesión con la cookie de refresh. Un único refresh en vuelo; devuelve false si ya no hay sesión. */
export function refreshSession(): Promise<boolean> {
  inflightRefresh ??= runRefresh().finally(() => { inflightRefresh = null; });
  return inflightRefresh;
}

async function runRefresh(): Promise<boolean> {
  const exec = async (): Promise<boolean> => {
    let res: Response;
    try {
      res = await fetch('/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json', [CSRF_HEADER]: CSRF_VALUE }, body: '{}', credentials: 'same-origin' });
    } catch {
      return false; // sin red: no se destruye nada, el llamador decide
    }
    if (!res.ok) { accessToken = null; return false; }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) { accessToken = null; return false; }
    accessToken = body.access_token;
    return true;
  };
  // Entre pestañas: el candado hace que la segunda lea la cookie YA rotada por la primera (si no, reutilizaría el refresh viejo)
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request('ss-refresh', exec) : exec();
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = 'HTTP_ERROR';
  let message = 'Ocurrió un error inesperado';
  let requestId: string | undefined;
  let details: ErrorDetail[] = [];
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string; request_id?: string; details?: ErrorDetail[] } };
    if (j.error) {
      code = j.error.code ?? code;
      message = j.error.message ?? message;
      requestId = j.error.request_id;
      details = j.error.details ?? [];
    }
  } catch {
    /* cuerpo no JSON */
  }
  const ra = Number(res.headers.get('retry-after'));
  return new ApiError(res.status, code, message, requestId, Number.isFinite(ra) && ra > 0 ? ra : undefined, details);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** false = ruta pública (login, registro…): no adjunta el access token ni intenta refrescar. */
  auth?: boolean;
  /** Cabeceras extra (CSRF del logout por cookie). */
  headers?: Record<string, string>;
}

export interface Download {
  blob: Blob;
  filename: string;
  /** Filas que trae el archivo (cabecera `X-Export-Count`), si el servidor la informa. */
  count: number | null;
}

/** Pide un archivo al servidor (exportación o reporte). Mismas reglas de sesión que `api`; el nombre sale de `Content-Disposition`. */
export async function apiDownload(path: string, opts: RequestOptions & { fallbackName: string }): Promise<Download> {
  const res = await rawRequest(path, opts);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const count = Number(res.headers.get('x-export-count'));
  return { blob: await res.blob(), filename: name ?? opts.fallbackName, count: res.headers.has('x-export-count') && Number.isFinite(count) ? count : null };
}

/** Inicia la descarga de un archivo en memoria. */
export function saveBlob(d: Download): void {
  const url = URL.createObjectURL(d.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = d.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await rawRequest(path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Envía la petición con el access token; ante un 401 refresca la sesión y repite una vez. Lanza `ApiError` si la respuesta no es correcta. */
async function rawRequest(path: string, opts: RequestOptions): Promise<Response> {
  const auth = opts.auth ?? true;
  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers };
    if (auth && accessToken) headers['authorization'] = `Bearer ${accessToken}`;
    try {
      return await fetch(`/v1${path}`, { method: opts.method ?? 'GET', headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}), credentials: 'same-origin' });
    } catch {
      throw new ApiError(0, 'NETWORK', 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.');
    }
  };

  let res = await send();
  if (res.status === 401 && auth) {
    if (await refreshSession()) res = await send();
    else for (const l of lostListeners) l();
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}
