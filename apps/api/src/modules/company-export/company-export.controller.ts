import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { TooManyAttemptsError } from '../../errors';
import { Public, PlatformOnly, WindowLimiter, ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import {
  downloadPartSchema,
  requestExportSchema,
  tokenDownloadSchema,
  tokenPasswordSchema,
  tokenSchema,
  uuidParam,
  type DownloadPartDto,
  type RequestExportDto,
  type TokenDownloadDto,
  type TokenDto,
  type TokenPasswordDto,
} from './company-export.dto';
import { CompanyExportService } from './company-export.service';

/**
 * Copia completa de los datos de una empresa eliminada, desde la Consola de la plataforma (F3b, ADR-59 #8). Solo el Súper Admin. El id de la ruta es el de la empresa a administrar. `no-store`:
 * las respuestas describen datos sensibles y no deben quedar en cachés.
 */
@PlatformOnly()
@RequirePermission('platform.companies.export')
@Controller('platform/companies')
export class PlatformCompanyExportController {
  constructor(@Inject(CompanyExportService) private readonly exports: CompanyExportService) {}

  @Get(':id/export')
  @Header('Cache-Control', 'no-store')
  status(@Param('id', new ZodValidationPipe(uuidParam)) id: string) {
    return this.exports.statusAsPlatform(id);
  }

  @Post(':id/export')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  request(@Param('id', new ZodValidationPipe(uuidParam)) id: string, @Body(new ZodValidationPipe(requestExportSchema)) b: RequestExportDto) {
    return this.exports.requestAsPlatform(id, b.password);
  }

  @Post(':id/export/download')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  download(@Param('id', new ZodValidationPipe(uuidParam)) id: string, @Body(new ZodValidationPipe(downloadPartSchema)) b: DownloadPartDto) {
    return this.exports.downloadAsPlatform(id, b.part);
  }
}

const MINUTE = 60_000;

/**
 * Páginas PÚBLICAS del dueño de una empresa eliminada (F3b, ADR-59 #9): no puede iniciar sesión, así que entra con el enlace de su correo. Sin sesión: el token del cuerpo dice qué empresa y la
 * contraseña dice quién. Un token que no vale responde siempre 404, sin decir por qué. Límite por dirección IP además del límite de intentos de contraseña (el mismo del inicio de sesión).
 * Todo `no-store`.
 */
@Public()
@Controller('public/company-export')
export class CompanyExportPublicController {
  private readonly perIp = new WindowLimiter(30, MINUTE);

  constructor(@Inject(CompanyExportService) private readonly exports: CompanyExportService) {}

  private gate(req: Request): void {
    const g = this.perIp.take(req.ip ?? '?');
    if (!g.ok) throw new TooManyAttemptsError(g.retryAfterSeconds);
  }

  @Post('status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  status(@Req() req: Request, @Body(new ZodValidationPipe(tokenSchema)) b: TokenDto) {
    this.gate(req);
    return this.exports.statusByToken(b.token);
  }

  @Post('request')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  request(@Req() req: Request, @Body(new ZodValidationPipe(tokenPasswordSchema)) b: TokenPasswordDto) {
    this.gate(req);
    return this.exports.requestByToken(b.token, b.password);
  }

  @Post('download')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  download(@Req() req: Request, @Body(new ZodValidationPipe(tokenDownloadSchema)) b: TokenDownloadDto) {
    this.gate(req);
    return this.exports.downloadByToken(b.token, b.password, b.part);
  }
}
