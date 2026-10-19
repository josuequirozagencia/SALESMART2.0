import type { NextFunction, Request, Response } from 'express';

/**
 * Lector de cuerpo CRUDO para rutas cuya firma se calcula sobre los bytes exactos (webhooks de Meta, M5.2). Va ANTES del lector JSON de Nest: deja el cuerpo
 * como `Buffer` en `req.body` y marca la petición como ya leída para que nadie lo reinterprete (reordenar o reformatear el JSON invalidaría la firma).
 * Solo actúa sobre POST a las rutas indicadas; límite de tamaño estricto (413 JSON estándar, sin leer el resto).
 */
export function rawBodyFor(paths: readonly string[], limitBytes: number) {
  const exact = new Set(paths);
  return (req: Request & { requestId?: string; _body?: boolean }, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST' || !exact.has(req.path)) return next();
    const reject = (): void => {
      if (res.headersSent) return;
      // Se responde y se cierra la conexión (sin cortarla antes de que el cliente lea la respuesta); lo que falte por llegar se descarta
      res.setHeader('Connection', 'close');
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'La solicitud es demasiado grande', request_id: req.requestId ?? null, details: [] } });
      req.resume();
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) return reject();
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (c: Buffer) => {
      if (rejected) return;
      size += c.length;
      if (size > limitBytes) {
        rejected = true;
        chunks.length = 0;
        reject();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
      req.body = Buffer.concat(chunks);
      req._body = true; // el lector JSON de Nest (body-parser) respeta esta marca y no vuelve a leer
      next();
    });
    req.on('error', (e) => next(e));
  };
}
