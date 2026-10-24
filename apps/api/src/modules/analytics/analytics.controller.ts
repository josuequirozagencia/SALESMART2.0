import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { TenantContext } from '../../tenant';
import { exportSchema, exportsQuerySchema, rangeQuerySchema, REPORTS, settingsSchema, type ExportDto, type ExportsQuery, type RangeQuery, type ReportName, type SettingsDto } from './analytics.dto';
import { AnalyticsService, type AnalyticsScope } from './analytics.service';

/** Quién consulta: la persona sale de TenantContext; los alcances dependen de los permisos (verificados por el guard). */
const scopeOf = (req: AuthedRequest): AnalyticsScope => {
  const has = (key: string): boolean => req.principal?.permissions?.has(key as never) === true;
  return { userId: TenantContext.current().userId ?? '', viewAll: has('analytics.view_all'), canExport: has('analytics.export'), canManage: has('analytics.manage') };
};

/**
 * Tablero y analítica (M6.5, ADR-51). Lectura: `analytics.view` (el asesor ve lo suyo; con `analytics.view_all`, toda la empresa). Descargar un reporte en CSV exige
 * `analytics.export` y, para el asesor, que el administrador no lo haya desactivado; cada descarga queda registrada con quién la hizo. Ver ese registro y activar o desactivar la
 * descarga del asesor exige `analytics.manage`. `no-store`: son datos de clientes y de dinero.
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @RequirePermission('analytics.view')
  @Get('summary')
  @Header('Cache-Control', 'no-store')
  async summary(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(rangeQuerySchema)) q: RangeQuery) {
    const scope = scopeOf(req);
    return { ...(await this.analytics.summary(scope, q)), access: await this.analytics.access(scope) };
  }

  @RequirePermission('analytics.view')
  @Get('reports/:name')
  @Header('Cache-Control', 'no-store')
  async report(@Req() req: AuthedRequest, @Param('name', new ZodValidationPipe(z.enum(REPORTS))) name: ReportName, @Query(new ZodValidationPipe(rangeQuerySchema)) q: RangeQuery) {
    const scope = scopeOf(req);
    return { ...(await this.analytics.report(scope, name, q)), access: await this.analytics.access(scope) };
  }

  /** CSV del reporte (BOM UTF-8, anti-fórmulas). POST porque deja rastro en el registro de descargas y en la auditoría. */
  @RequirePermission('analytics.export')
  @Post('export')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async export(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(exportSchema)) b: ExportDto, @Res({ passthrough: true }) res: Response): Promise<string> {
    const r = await this.analytics.export(scopeOf(req), b);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    res.setHeader('X-Export-Count', String(r.count));
    return r.csv;
  }

  /** Quién descargó qué y cuándo (la pestaña «Descargas»). */
  @RequirePermission('analytics.manage')
  @Get('exports')
  @Header('Cache-Control', 'no-store')
  exports(@Query(new ZodValidationPipe(exportsQuerySchema)) q: ExportsQuery) {
    return this.analytics.exportsLog(q);
  }

  @RequirePermission('analytics.manage')
  @Get('settings')
  @Header('Cache-Control', 'no-store')
  settings() {
    return this.analytics.settings();
  }

  /** Activa o desactiva la descarga de reportes para el asesor. */
  @RequirePermission('analytics.manage')
  @Put('settings')
  @Header('Cache-Control', 'no-store')
  updateSettings(@Body(new ZodValidationPipe(settingsSchema)) b: SettingsDto) {
    return this.analytics.updateSettings(b);
  }
}
