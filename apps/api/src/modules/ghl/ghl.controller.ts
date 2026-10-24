import { Body, Controller, Get, Header, HttpCode, Inject, Post, Put } from '@nestjs/common';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { GhlConnectionService } from './ghl-connection.service';
import { saveConnectionSchema, type SaveConnectionDto } from './ghl.dto';

/**
 * Conexión de la empresa con GoHighLevel (M7.1, ADR-52). Solo quien administra integraciones (`integrations.manage`); `no-store`: son credenciales. El token jamás se devuelve (solo sus
 * últimos 4) y el secreto del webhook solo viaja al generarlo o rotarlo.
 */
@Controller('ghl')
export class GhlController {
  constructor(@Inject(GhlConnectionService) private readonly ghl: GhlConnectionService) {}

  @RequirePermission('integrations.manage')
  @Get('connection')
  @Header('Cache-Control', 'no-store')
  connection() {
    return this.ghl.get();
  }

  @RequirePermission('integrations.manage')
  @Put('connection')
  @Header('Cache-Control', 'no-store')
  save(@Body(new ZodValidationPipe(saveConnectionSchema)) b: SaveConnectionDto) {
    return this.ghl.save(b);
  }

  /** «Probar»: vuelve a comprobar con GHL el token guardado. */
  @RequirePermission('integrations.manage')
  @Post('connection/test')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  test() {
    return this.ghl.test();
  }

  /** Desconecta y borra el token. */
  @RequirePermission('integrations.manage')
  @Post('connection/disconnect')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  disconnect() {
    return this.ghl.disconnect();
  }

  /** Crea el punto de entrada del Workflow o rota su secreto (el anterior deja de servir). El secreto se muestra esta única vez. */
  @RequirePermission('integrations.manage')
  @Post('webhook/secret')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  secret() {
    return this.ghl.issueWebhookSecret();
  }
}
