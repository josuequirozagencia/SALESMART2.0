import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { CATCH_UP_MAX_HOURS, QrCatchUpService } from './qr-catch-up.service';
import { QrConnectionsService } from './qr-connections.service';

const idParam = new ZodValidationPipe(z.uuid());
const name = z.string().trim().min(1).max(60);
const createSchema = z.strictObject({ name, queue_id: z.uuid().nullable().optional(), prior_use_risk_accepted: z.boolean().optional() });
const updateSchema = z
  .strictObject({ name: name.optional(), queue_id: z.uuid().nullable().optional() })
  .refine((b) => Object.keys(b).length > 0, 'No hay nada que cambiar');
const catchUpSchema = z.strictObject({ hours: z.number().int().min(1).max(CATCH_UP_MAX_HOURS).default(48) });
type CatchUpDto = z.infer<typeof catchUpSchema>;
type CreateDto = z.infer<typeof createSchema>;
type UpdateDto = z.infer<typeof updateSchema>;

/**
 * Conexiones de WhatsApp por QR de la empresa (M9.6, ADR-54/ADR-31; canal NO OFICIAL): crear, vincular con un QR, ver el estado de la sesión, cerrarla y borrar. Solo quien administra conexiones
 * (`channels.manage`). La clave de Evolution es de la plataforma y nunca aparece aquí. Todo `no-store`.
 */
@RequirePermission('channels.manage')
@Controller('qr-channels')
export class QrController {
  constructor(
    @Inject(QrConnectionsService) private readonly qr: QrConnectionsService,
    @Inject(QrCatchUpService) private readonly catchUp: QrCatchUpService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.qr.list();
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(createSchema)) b: CreateDto) {
    return this.qr.create(b);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  status(@Param('id', idParam) id: string) {
    return this.qr.status(id);
  }

  /** Un QR nuevo para vincular el teléfono (dura ~30 s). */
  @Post(':id/qr')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  code(@Param('id', idParam) id: string) {
    return this.qr.qr(id);
  }

  /**
   * «Ponerse al día» (v19 B3): lee de Evolution los mensajes de las últimas `hours` horas (hasta 168), descarta los que ya están y pone el resto en cola para que entren a la bandeja. Solo lectura sobre Evolution;
   * se puede repetir sin duplicar nada.
   */
  @Post(':id/catch-up')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  catchUpNow(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(catchUpSchema)) b: CatchUpDto) {
    return this.catchUp.run(id, b.hours);
  }

  @Post(':id/disconnect')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  disconnect(@Param('id', idParam) id: string) {
    return this.qr.disconnect(id);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateSchema)) b: UpdateDto) {
    return this.qr.update(id, b);
  }

  @Delete(':id')
  @Header('Cache-Control', 'no-store')
  remove(@Param('id', idParam) id: string) {
    return this.qr.remove(id);
  }
}
