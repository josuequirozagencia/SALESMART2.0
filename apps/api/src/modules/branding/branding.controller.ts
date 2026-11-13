import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError, NotFoundError } from '../../errors';
import { Public, PlatformOnly, WindowLimiter, ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { IMAGE_MAX_BYTES } from '../platform';
import { BrandingService, type PublicFile, type ServedFile } from './branding.service';

/** Lee el cuerpo hasta `limit` bytes. Se lee AQUÍ —después de autenticar y de comprobar el permiso—, así quien no es Súper Admin no hace que el servidor reciba nada. */
function readBody(req: Request, limit: number, code: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): AppError => new AppError(413, code, `El archivo pesa demasiado: el máximo es ${limit / 1024 / 1024} MB`);
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
      if (!over) reject(new AppError(400, 'BRANDING_UPLOAD_FAILED', 'La subida del archivo se interrumpió'));
    });
  });
}

const nameSchema = z.strictObject({ name: z.string().max(200).nullable(), short_name: z.string().max(100).nullable() });
type NameDto = z.infer<typeof nameSchema>;

/**
 * Marca de la plataforma para el Súper Admin (v11 §3): ver el estado, cambiar el nombre y subir o quitar el icono y los logos (cuerpo crudo: la imagen). El tipo que declare el navegador no se usa:
 * se valida el contenido. `no-store`.
 */
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

  /** El nombre de la plataforma y su versión corta; `null` en ambos = volver al valor por defecto. */
  @Put()
  @Header('Cache-Control', 'no-store')
  setName(@Body(new ZodValidationPipe(nameSchema)) b: NameDto) {
    return this.branding.setName(b.name, b.short_name);
  }

  /** El cuerpo ES el PNG del icono (cuadrado, de 512 a 4096 px). De él salen el favicon, el icono de instalación y el de las notificaciones. */
  @Put('icon')
  @Header('Cache-Control', 'no-store')
  async setIcon(@Req() req: Request) {
    return this.branding.setIcon(await readBody(req, IMAGE_MAX_BYTES, 'ICON_TOO_LARGE'));
  }

  @Delete('icon')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  clearIcon() {
    return this.branding.clearIcon();
  }

  @Put('logo-light')
  @Header('Cache-Control', 'no-store')
  async setLogoLight(@Req() req: Request) {
    return this.branding.setLogo('light', await readBody(req, IMAGE_MAX_BYTES, 'LOGO_TOO_LARGE'));
  }

  @Delete('logo-light')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  clearLogoLight() {
    return this.branding.clearLogo('light');
  }

  @Put('logo-dark')
  @Header('Cache-Control', 'no-store')
  async setLogoDark(@Req() req: Request) {
    return this.branding.setLogo('dark', await readBody(req, IMAGE_MAX_BYTES, 'LOGO_TOO_LARGE'));
  }

  @Delete('logo-dark')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  clearLogoDark() {
    return this.branding.clearLogo('dark');
  }
}

/** Nombres públicos de los archivos → cuál se entrega. */
const FILES: Record<string, PublicFile> = {
  'icon-32.png': 'icon-32',
  'icon-48.png': 'icon-48',
  'apple-touch-icon.png': 'icon-180',
  'icon-192.png': 'icon-192',
  'icon-512.png': 'icon-512',
  'badge-96.png': 'badge-96',
  'logo-light': 'logo-light',
  'logo-dark': 'logo-dark',
};
const ONE_YEAR = 31_536_000;

/**
 * La marca PÚBLICA (el navegador, el service worker y la pantalla de acceso la piden sin sesión): `GET /v1/branding` (nombre, versión y direcciones), el manifest y los archivos. No exponen nada de
 * ninguna empresa. Con límite de peticiones por IP. Un archivo pedido con su versión (`?v=`) vigente se guarda un año; sin ella, 5 minutos; la versión hace de ETag. Iconos y badge nunca dan 404:
 * sin archivo propio se entrega el de por omisión.
 */
@Public()
@Controller('branding')
export class BrandingPublicController {
  private readonly limiter = new WindowLimiter(240, 60_000);

  constructor(@Inject(BrandingService) private readonly branding: BrandingService) {}

  private gate(req: Request, res: Response): void {
    const g = this.limiter.take(req.ip ?? '?');
    if (g.ok) return;
    res.setHeader('Retry-After', String(g.retryAfterSeconds));
    throw new AppError(429, 'RATE_LIMITED', 'Demasiadas solicitudes: inténtalo de nuevo en un momento');
  }

  private notModified(req: Request, res: Response, etag: string): boolean {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] !== etag) return false;
    res.status(304).end();
    return true;
  }

  @Get()
  async info(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.gate(req, res);
    const info = await this.branding.publicInfo();
    res.setHeader('Cache-Control', 'public, max-age=60');
    if (this.notModified(req, res, this.branding.etagOf(info))) return;
    res.status(200).json(info);
  }

  @Get('manifest.webmanifest')
  async manifest(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.gate(req, res);
    const m = await this.branding.manifest();
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (this.notModified(req, res, this.branding.etagOf(m))) return;
    res.status(200).type('application/manifest+json').send(JSON.stringify(m));
  }

  @Get('favicon')
  async favicon(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.gate(req, res);
    this.send(req, res, (await this.branding.serve('favicon'))!);
  }

  @Get(':file')
  async file(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.gate(req, res);
    const name = (req.params as Record<string, string>)['file'] ?? '';
    const which = Object.hasOwn(FILES, name) ? FILES[name] : undefined;
    if (!which) throw new NotFoundError();
    const f = await this.branding.serve(which);
    if (!f) throw new NotFoundError();
    this.send(req, res, f);
  }

  private send(req: Request, res: Response, f: ServedFile): void {
    const versioned = req.query['v'] === f.version;
    res.setHeader('Cache-Control', versioned ? `public, max-age=${ONE_YEAR}, immutable` : 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (this.notModified(req, res, `"${f.version}"`)) return;
    res.status(200).setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Length', String(f.bytes.length));
    res.end(f.bytes);
  }
}
