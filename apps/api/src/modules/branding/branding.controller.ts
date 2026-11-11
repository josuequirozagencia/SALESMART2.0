import { Controller, Delete, Get, Header, HttpCode, Inject, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from '../../errors';
import { Public, PlatformOnly } from '../../http';
import { RequirePermission } from '../../rbac';
import { FAVICON_MAX_BYTES } from '../platform';
import { BrandingService } from './branding.service';

/** Lee el cuerpo hasta `limit` bytes. Se lee AQUÍ —después de autenticar y de comprobar el permiso—, así quien no es Súper Admin no hace que el servidor reciba nada. */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): AppError => new AppError(413, 'FAVICON_TOO_LARGE', `El archivo pesa demasiado: el máximo es ${FAVICON_MAX_BYTES / 1024} KB`);
    const declared = Number(req.headers['content-length']);
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
      if (!over) reject(new AppError(400, 'FAVICON_UPLOAD_FAILED', 'La subida del archivo se interrumpió'));
    });
  });
}

/** Marca de la plataforma para el Súper Admin (v11 S3): ver el estado, subir el favicon (cuerpo crudo: la imagen) y quitarlo. `no-store`. */
@PlatformOnly()
@RequirePermission('platform.branding.manage')
@Controller('platform/branding')
export class BrandingController {
  constructor(@Inject(BrandingService) private readonly branding: BrandingService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  view() {
    return this.branding.view();
  }

  /** El cuerpo ES la imagen (PNG, ICO o WebP). El tipo que declare el navegador no se usa: se valida el contenido. */
  @Put('favicon')
  @Header('Cache-Control', 'no-store')
  async set(@Req() req: Request) {
    return this.branding.setFavicon(await readBody(req, FAVICON_MAX_BYTES));
  }

  @Delete('favicon')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  clear() {
    return this.branding.clear();
  }
}

/**
 * `GET /v1/branding/favicon`: PÚBLICO (el navegador lo pide sin sesión). Entrega solo la imagen: nada de ninguna empresa. Se puede guardar 5 minutos; la versión hace de ETag. Sin favicon
 * subido (o con el almacenamiento caído) entrega el icono por omisión, así la pestaña nunca queda con un 404.
 */
@Public()
@Controller('branding')
export class BrandingPublicController {
  constructor(@Inject(BrandingService) private readonly branding: BrandingService) {}

  @Get('favicon')
  async favicon(@Req() req: Request, @Res() res: Response): Promise<void> {
    const f = await this.branding.serve();
    const etag = `"${f.version}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.status(200).setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Length', String(f.bytes.length));
    res.end(f.bytes);
  }
}
