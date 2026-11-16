import type { Request } from 'express';
import { AppError } from '../errors';

/**
 * Lee el cuerpo de la petición hasta `limit` bytes. Se lee AQUÍ —después de la autenticación y los permisos— y no en un middleware, para que quien no tiene sesión no pueda
 * hacer que el servidor reciba decenas de megas. Si pasa del tope responde 413 sin guardar el resto.
 */
export function readUploadBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    const tooLarge = (): AppError => new AppError(413, 'ATTACHMENT_TOO_LARGE', `El archivo pesa demasiado: el máximo es ${Math.floor(limit / (1024 * 1024))} MB`);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return reject(tooLarge());
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        req.res?.setHeader('Connection', 'close');
        req.resume();
        return reject(tooLarge());
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!over) reject(new AppError(400, 'ATTACHMENT_UPLOAD_FAILED', 'La subida del archivo se interrumpió'));
    });
  });
}

/** El nombre que manda el navegador en `X-Filename` (codificado con `encodeURIComponent`). */
export function uploadFilenameOf(req: Request): string | null {
  const raw = req.headers['x-filename'];
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 600 ? raw : null;
}

