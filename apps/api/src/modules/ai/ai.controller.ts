import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { PlatformOnly, ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { AiAdminService } from './ai-admin.service';
import { AiCreditsService } from './ai-credits.service';
import { adminOrganizationsQuerySchema, creditsQuerySchema, grantSchema, idempotencyKeySchema, marginSchema, pricingSchema, type AdminOrganizationsQuery, type CreditsQuery, type GrantDto, type MarginDto, type PricingDto } from './ai.dto';

const orgParam = new ZodValidationPipe(z.uuid());

/** Créditos IA de la empresa del contexto (M8.1, ADR-19/53): saldo y movimientos. Créditos y a qué corresponden; NUNCA el costo, el margen ni el proveedor. `no-store`. */
@Controller('ai')
export class AiCreditsController {
  constructor(@Inject(AiCreditsService) private readonly credits: AiCreditsService) {}

  @RequirePermission('ai.credits.view')
  @Get('credits')
  @Header('Cache-Control', 'no-store')
  view(@Query(new ZodValidationPipe(creditsQuerySchema)) q: CreditsQuery) {
    return this.credits.view(q);
  }
}

/** La llave de idempotencia es obligatoria en lo que mueve dinero: sin ella, un reintento de red podría regalar dos veces. */
function keyOf(raw: string | undefined): string {
  const r = idempotencyKeySchema.safeParse(raw);
  if (!r.success) throw new ValidationError([{ path: 'Idempotency-Key', code: raw ? 'invalid' : 'required', message: 'Envía una cabecera Idempotency-Key única por operación (8 a 100 caracteres: letras, números y _ . : -)' }]);
  return r.data;
}

/**
 * Créditos IA para el SÚPER ADMIN (M8.1): precio y margen, saldos de todas las empresas, regalos y el libro con costo y margen. Solo plataforma (`platform.ai.manage`); los ids de la ruta son
 * empresas CLIENTE (404 uniforme si no lo son). `no-store`.
 */
@PlatformOnly()
@RequirePermission('platform.ai.manage')
@Controller('platform/ai')
export class AiAdminController {
  constructor(@Inject(AiAdminService) private readonly admin: AiAdminService) {}

  @Get('pricing')
  @Header('Cache-Control', 'no-store')
  pricing() {
    return this.admin.getPricing();
  }

  @Put('pricing')
  @Header('Cache-Control', 'no-store')
  setPricing(@Body(new ZodValidationPipe(pricingSchema)) b: PricingDto) {
    return this.admin.setPricing(b);
  }

  @Get('organizations')
  @Header('Cache-Control', 'no-store')
  organizations(@Query(new ZodValidationPipe(adminOrganizationsQuerySchema)) q: AdminOrganizationsQuery) {
    return this.admin.organizations(q);
  }

  /** Margen propio de una empresa (`null` vuelve al global). */
  @Put('organizations/:id/margin')
  @Header('Cache-Control', 'no-store')
  margin(@Param('id', orgParam) id: string, @Body(new ZodValidationPipe(marginSchema)) b: MarginDto) {
    return this.admin.setMargin(id, b);
  }

  @Post('organizations/:id/grants')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  grant(@Param('id', orgParam) id: string, @Headers('idempotency-key') key: string | undefined, @Body(new ZodValidationPipe(grantSchema)) b: GrantDto) {
    return this.admin.grant(id, b, keyOf(key));
  }

  @Get('organizations/:id/ledger')
  @Header('Cache-Control', 'no-store')
  ledger(@Param('id', orgParam) id: string, @Query(new ZodValidationPipe(creditsQuerySchema)) q: CreditsQuery) {
    return this.admin.ledger(id, q);
  }
}
