import { Controller, Delete, Get, Header, Inject, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { MAX_PHOTO_BYTES, PhotosService } from './photos.service';

const ids = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(',') : []))
  .pipe(z.array(z.uuid()).max(50));
const querySchema = z.object({ contacts: ids, users: ids });
type PhotosQuery = z.output<typeof querySchema>;

/** Lee el cuerpo hasta `limit` bytes DESPUÉS de la autenticación y los permisos (como la foto de los agentes): 413 sin guardar el resto. */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): AppError => new AppError(413, 'PHOTO_TOO_LARGE', `La foto pesa demasiado: el máximo es ${Math.floor(limit / (1024 * 1024))} MB`);
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
      if (!over) reject(new AppError(400, 'PHOTO_UPLOAD_FAILED', 'La subida de la foto se interrumpió'));
    });
  });
}

const userOf = (req: AuthedRequest): string => {
  const id = req.principal?.userId;
  if (!id) throw new AppError(401, 'UNAUTHORIZED', 'Se necesita iniciar sesión');
  return id;
};

/**
 * Fotos de perfil (v5): `GET /photos?contacts=…&users=…` da las URL firmadas de lo que la pantalla muestra (hasta 50 de cada uno) y `/me/photo` es la foto de quien pregunta (ver, subir con el archivo tal
 * cual —JPEG, PNG o WebP de hasta 2 MB— y quitar). Las dos cosas piden `inbox.read` (lo que ya necesita quien ve conversaciones). `no-store`.
 */
@RequirePermission('inbox.read')
@Controller()
export class PhotosController {
  constructor(@Inject(PhotosService) private readonly photos: PhotosService) {}

  @Get('photos')
  @Header('Cache-Control', 'no-store')
  resolve(@Query(new ZodValidationPipe(querySchema)) q: PhotosQuery, @Req() req: AuthedRequest) {
    const p = req.principal?.permissions;
    return this.photos.resolve({ contacts: q.contacts, users: q.users }, { userId: userOf(req), viewAll: p?.has('contacts.view_all') === true || p?.has('inbox.view_all') === true });
  }

  @Get('me/photo')
  @Header('Cache-Control', 'no-store')
  mine(@Req() req: AuthedRequest) {
    return this.photos.mine(userOf(req));
  }

  @Put('me/photo')
  @Header('Cache-Control', 'no-store')
  async set(@Req() req: AuthedRequest) {
    const userId = userOf(req);
    return this.photos.setMine(userId, await readBody(req, MAX_PHOTO_BYTES));
  }

  @Delete('me/photo')
  @Header('Cache-Control', 'no-store')
  remove(@Req() req: AuthedRequest) {
    return this.photos.removeMine(userOf(req));
  }
}
