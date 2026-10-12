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
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders(res: Response, production: boolean): void {
  res.setHeader('Content-Security-Policy', CSP);
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
    securityHeaders(res, opts.production);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(indexFile, { dotfiles: 'deny' }, (err) => {
      if (err) next(err);
    });
  });
}
