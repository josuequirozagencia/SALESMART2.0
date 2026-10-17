import { Body, Controller, Header, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { exportSchema, type ExportDto } from './contact-export';
import { ContactExportService } from './contact-export.service';

/**
 * Exportar contactos a CSV (M3.5, ADR-47). Solo `contacts.export` (el administrador); rige el alcance por persona del ADR-43 y cada exportación queda en la
 * auditoría (quién, cuándo, cuántos, qué filtros y columnas). POST porque lleva filtros y, a veces, hasta 5 000 ids de una selección.
 */
@Controller('contacts')
export class ContactExportController {
  constructor(@Inject(ContactExportService) private readonly exporter: ContactExportService) {}

  @RequirePermission('contacts.export')
  @Post('export')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async export(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(exportSchema)) b: ExportDto, @Res({ passthrough: true }) res: Response): Promise<string> {
    const r = await this.exporter.export({ viewAll: req.principal?.permissions?.has('contacts.view_all') === true }, b);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
    res.setHeader('X-Export-Count', String(r.count));
    return r.csv;
  }
}
