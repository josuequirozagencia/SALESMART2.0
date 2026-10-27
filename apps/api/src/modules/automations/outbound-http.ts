import { lookup } from 'node:dns/promises';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isPublicAddress } from './address-guard';

/** Lo que pide la acción «llamada HTTP» (M9.5b, ADR-54). La dirección ya pasó `parseDestination` y la lista de permitidos. */
export interface OutboundRequest {
  readonly url: URL;
  readonly method: 'GET' | 'POST';
  /** JSON ya armado (solo con POST). */
  readonly body: string | null;
  /** Para que el destino pueda descartar un reintento: `<ejecución>:<paso>`. */
  readonly idempotencyKey: string;
}
/** De la respuesta solo importa el código: el cuerpo no se guarda (puede traer datos personales o secretos). */
export interface OutboundResponse {
  readonly status: number;
}

export type OutboundFailure = 'blocked' | 'dns' | 'timeout' | 'connect' | 'tls' | 'too_large';

/** Falla de la llamada con un motivo y un texto SIN la dirección completa ni nada del cuerpo. */
export class OutboundError extends Error {
  constructor(
    readonly reason: OutboundFailure,
    message: string,
  ) {
    super(message);
  }
}

export const OUTBOUND_HTTP = Symbol('OUTBOUND_HTTP');

/** Puerto de salida: lo único por donde una automatización llama a internet. */
export interface OutboundHttp {
  send(req: OutboundRequest): Promise<OutboundResponse>;
}

export const OUTBOUND_TIMEOUT_MS = 10_000;
/** Lo que se lee de la respuesta antes de descartarla (solo hace falta el código). */
export const OUTBOUND_MAX_RESPONSE_BYTES = 64 * 1024;
export const OUTBOUND_MAX_BODY_BYTES = 8 * 1024;

type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
type Transport = { request: typeof https.request };

const defaultResolve: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/**
 * Salida real (M9.5b). Defensas, en orden: (1) **resuelve el nombre ANTES** y rechaza si CUALQUIERA de las direcciones no es pública (una respuesta mixta no se acepta); (2) **conecta a la IP
 * ya validada** (no vuelve a resolver: sin «DNS rebinding») y valida el certificado contra el NOMBRE; (3) **no sigue redirecciones**; (4) **10 s en total**; (5) lee a lo sumo 64 KB de la
 * respuesta y la descarta. Nunca lleva cookies ni cabeceras de la empresa. Los errores no incluyen la dirección.
 */
export class SafeHttpClient implements OutboundHttp {
  private readonly resolve: Resolver;
  private readonly transport: Transport;
  private readonly timeoutMs: number;

  /** `resolve` y `transport` solo se sustituyen en las pruebas (un servidor local sin TLS: el transporte de prueba reemplaza el puerto y el protocolo); en producción siempre `dns` + `https`. */
  constructor(opts: { resolve?: Resolver; transport?: Transport; timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
    this.resolve = opts.resolve ?? defaultResolve;
    this.transport = opts.transport ?? https;
  }

  async send(req: OutboundRequest): Promise<OutboundResponse> {
    let addrs: Array<{ address: string; family: number }>;
    try {
      addrs = await this.resolve(req.url.hostname);
    } catch {
      throw new OutboundError('dns', 'No se pudo encontrar el servidor de destino');
    }
    if (addrs.length === 0) throw new OutboundError('dns', 'No se pudo encontrar el servidor de destino');
    if (!addrs.every((a) => isPublicAddress(a.address))) throw new OutboundError('blocked', 'El destino apunta a una dirección que no es pública y no se permite');
    return this.pinned(req, addrs[0]!);
  }

  /** La conexión a UNA dirección ya validada. Pública solo para probar el transporte con un servidor local; `send` es el único camino que valida. */
  pinned(req: OutboundRequest, target: { address: string; family: number }): Promise<OutboundResponse> {
    return new Promise<OutboundResponse>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const pin: LookupFunction = (_host, options, cb) => {
        if (options.all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [target]);
        else cb(null, target.address, target.family);
      };
      const body = req.body === null ? null : Buffer.from(req.body, 'utf8');
      const request = this.transport.request(
        {
          protocol: req.url.protocol,
          hostname: req.url.hostname,
          port: 443,
          path: `${req.url.pathname}${req.url.search}`,
          method: req.method,
          lookup: pin,
          servername: req.url.hostname,
          agent: false,
          headers: {
            Host: req.url.host,
            'User-Agent': 'SalesSmart-Automations/1',
            Accept: '*/*',
            'Idempotency-Key': req.idempotencyKey,
            Connection: 'close',
            ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}),
          },
        },
        (res) => {
          let read = 0;
          res.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read > OUTBOUND_MAX_RESPONSE_BYTES) {
              res.destroy();
              done(() => resolve({ status: res.statusCode ?? 0 })); // el código ya llegó: lo demás se descarta
            }
          });
          res.on('end', () => done(() => resolve({ status: res.statusCode ?? 0 })));
          res.on('error', () => done(() => resolve({ status: res.statusCode ?? 0 })));
        },
      );
      const timer = setTimeout(() => {
        request.destroy();
        done(() => reject(new OutboundError('timeout', 'El servidor de destino tardó demasiado en responder')));
      }, this.timeoutMs);
      request.on('error', (e: NodeJS.ErrnoException) => {
        const tls = typeof e.code === 'string' && /CERT|TLS|SSL|HOSTNAME/.test(e.code);
        done(() => reject(new OutboundError(tls ? 'tls' : 'connect', tls ? 'El certificado del servidor de destino no es válido' : 'No se pudo conectar con el servidor de destino')));
      });
      if (body) request.write(body);
      request.end();
    });
  }
}

/** Solo para desarrollo y pruebas (`HTTP_OUT_PROVIDER=fake`; se rechaza en producción): no sale a internet, anota lo pedido y contesta lo programado. */
export class FakeOutboundHttp implements OutboundHttp {
  readonly sent: OutboundRequest[] = [];
  private queue: Array<OutboundResponse | OutboundError> = [];

  /** Lo que contestará la próxima llamada (en orden). Sin nada programado: 200. */
  reply(...next: Array<OutboundResponse | OutboundError>): void {
    this.queue.push(...next);
  }

  reset(): void {
    this.sent.length = 0;
    this.queue = [];
  }

  send(req: OutboundRequest): Promise<OutboundResponse> {
    this.sent.push(req);
    const r = this.queue.shift() ?? { status: 200 };
    return r instanceof OutboundError ? Promise.reject(r) : Promise.resolve(r);
  }
}
