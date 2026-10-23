import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import serveStatic from 'serve-static';

/**
 * Sirve la web compilada (apps/web/dist) desde la propia API (ADR-36): UN solo origen para web y API, así la cookie de
 * refresh (HttpOnly, SameSite=Strict, Path=/v1/auth) y las peticiones /v1 funcionan SIN CORS.
 *
 * Reglas:
 *  - `/v1/*` y los sondeos de salud NUNCA caen aquí (los atiende Nest antes: este montaje va después de las rutas).
 *  - Archivos con hash (assets/…): caché larga e inmutable. `index.html` y las rutas de la SPA: sin caché.
 *  - Una ruta de la SPA (`/login`, `/signup`…) devuelve index.html solo si el cliente acepta HTML; un archivo inexistente
 *    (`/assets/x.js`) o un método distinto de GET/HEAD responde el 404 JSON estándar (no se disfraza con index.html).
 *  - Sin dotfiles, sin listado de directorios; serve-static resuelve el camino con protección contra `..`.
 *  - Cabeceras de seguridad en todo lo que sirve (CSP incluida). El CAPTCHA (Cloudflare Turnstile) es el único tercero
 *    permitido para scripts/iframes; las fuentes de Google son las del prototipo (se autoalojarán más adelante).
 */
export interface WebStaticOptions {
  distDir: string;
  /** En producción se añade HSTS (Railway termina TLS delante). */
  production: boolean;
  /** Orígenes extra para imágenes, audio y video (almacenamiento de archivos). Si falla, la web se sirve con la política base. */
  mediaOrigins?: MediaOrigins;
}

/** Token con el que un módulo (adjuntos) ofrece los orígenes desde donde el navegador puede leer imágenes, audio y video (la URL firmada del almacenamiento). `HttpModule` lo busca sin depender de ese módulo. */
export const WEB_MEDIA_ORIGINS = Symbol('WEB_MEDIA_ORIGINS');
export type MediaOrigins = () => Promise<readonly string[]>;

/** Solo se acepta un origen (esquema + servidor + puerto): nada que pueda colar otra directiva o un comodín en la CSP. */
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;
export const safeOrigins = (list: readonly string[]): string[] => [...new Set(list.filter((o) => ORIGIN.test(o)))];

/**
 * La política de la web. Los archivos de los clientes (imágenes, audio, video) se leen directamente del almacenamiento con una URL firmada, que es OTRO origen: sin
 * permitirlo en `img-src` y `media-src` el navegador los bloquearía. Es el único origen añadido, y solo para esas dos directivas (no scripts, no conexiones).
 */
export function buildCsp(mediaOrigins: readonly string[] = []): string {
  const extra = safeOrigins(mediaOrigins).join(' ');
  const withExtra = (base: string): string => (extra === '' ? base : `${base} ${extra}`);
  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    withExtra("img-src 'self' data:"),
    withExtra("media-src 'self'"),
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

export const CSP = buildCsp();

function securityHeaders(res: Response, production: boolean, csp: string = CSP): void {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); // el enlace de restablecer lleva el token en el fragmento: nunca sale en Referer
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}

const notFound = (req: Request & { requestId?: string }, res: Response): void => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Recurso no encontrado', request_id: req.requestId ?? 'unknown', details: [] } });
};

export function mountWeb(express: Express, opts: WebStaticOptions): void {
  const dir = path.resolve(opts.distDir);
  const indexFile = path.join(dir, 'index.html');
  if (!existsSync(indexFile)) throw new Error(`WEB_DIST_DIR no contiene index.html (${dir}): ejecuta \`pnpm build\``);

  const files = serveStatic(dir, {
    index: false, // la raíz y las rutas de la SPA las resuelve el manejador de abajo
    dotfiles: 'ignore',
    redirect: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      securityHeaders(res as unknown as Response, opts.production);
      const hashed = filePath.split(path.sep).includes('assets');
      res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  express.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    files(req, res, next);
  });

  express.use((req: Request & { requestId?: string }, res: Response, next: NextFunction) => {
    const isPage = (req.method === 'GET' || req.method === 'HEAD') && !path.extname(req.path) && Boolean(req.accepts('html'));
    if (!isPage) return notFound(req, res);
    const send = (csp: string): void => {
      securityHeaders(res, opts.production, csp);
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(indexFile, { dotfiles: 'deny' }, (err) => {
        if (err) next(err);
      });
    };
    // La política depende de la configuración del almacenamiento (se lee con caché corta); si no se puede leer, la web igual se sirve con la base
    if (!opts.mediaOrigins) return send(CSP);
    opts.mediaOrigins().then((origins) => send(buildCsp(origins)), () => send(CSP));
  });
}
