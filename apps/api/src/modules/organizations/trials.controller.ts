import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { AllowWhenPaused, SelfService, ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { requestExtensionSchema, type RequestExtensionDto } from './trials.dto';
import { TrialsService } from './trials.service';

/**
 * Prueba gratuita del propio cliente. La organización sale SIEMPRE del principal verificado (sesión + membresía): el
 * controlador solo le pasa el principal al servicio y nunca lee ni acepta una organización de la petición (ADR24-P5).
 * Son las únicas rutas de negocio que siguen abiertas con la cuenta vencida (@AllowWhenPaused).
 */
@Controller('trials')
export class TrialsController {
  constructor(@Inject(TrialsService) private readonly trials: TrialsService) {}

  /** Estado de la prueba para la pantalla de «vencida» y el aviso de días restantes. Cualquier miembro puede verlo. */
  @SelfService()
  @Get('me')
  me(@Req() req: AuthedRequest) {
    return this.trials.mine(req.principal);
  }

  /** Pide la única extensión de la cuenta. Solo quien administra la facturación de la organización. */
  @AllowWhenPaused()
  @RequirePermission('billing.manage')
  @Post('me/extension')
  @HttpCode(202)
  requestExtension(@Body(new ZodValidationPipe(requestExtensionSchema)) b: RequestExtensionDto, @Req() req: AuthedRequest) {
    return this.trials.requestMine(req.principal, b.reason);
  }
}
