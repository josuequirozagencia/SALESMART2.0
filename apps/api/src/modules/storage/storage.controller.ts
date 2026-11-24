import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../../errors';
import { PlatformOnly, ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { StorageAdminService } from './storage-admin.service';
import { StorageRequestsService } from './storage-requests.service';
import { grantSchema, planSchema, planUpdateSchema, requestSchema, revokeSchema, StoragePlansService, type GrantDto, type PlanDto, type PlanUpdateDto, type RequestDto, type RevokeDto } from '../platform';

const idParam = new ZodValidationPipe(z.uuid());
const keySchema = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/, 'solo letras, números y _ . : -');
const listQuery = z.strictObject({ q: z.string().trim().max(80).optional(), only_requests: z.enum(['true', 'false']).optional() });

/** La llave de idempotencia es obligatoria al conceder: un reintento de red no debe sumar el espacio dos veces. */
function keyOf(raw: string | undefined): string {
  const r = keySchema.safeParse(raw);
  if (!r.success) throw new ValidationError([{ path: 'Idempotency-Key', code: raw ? 'invalid' : 'required', message: 'Envía una cabecera Idempotency-Key única por operación (8 a 100 caracteres: letras, números y _ . : -)' }]);
  return r.data;
}

/** Espacio de la biblioteca, lado del cliente (V21b, ADR-75): los planes con su precio de lista y la solicitud de más espacio. Solo el administrador de la empresa. `no-store`. */
@Controller('library')
export class StorageClientController {
  constructor(@Inject(StorageRequestsService) private readonly requests: StorageRequestsService) {}

  @RequirePermission('library.manage')
  @Get('storage-plans')
  @Header('Cache-Control', 'no-store')
  plans() {
    return this.requests.options();
  }

  @RequirePermission('library.manage')
  @Post('storage-requests')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  request(@Body(new ZodValidationPipe(requestSchema)) b: RequestDto) {
    return this.requests.create(b);
  }
}

/** Espacio de la biblioteca, lado de la plataforma (V21b): catálogo de planes, solicitudes, concesiones y anulaciones. Solo el Súper Admin. */
@PlatformOnly()
@RequirePermission('platform.storage.manage')
@Controller('platform')
export class StoragePlatformController {
  constructor(
    @Inject(StoragePlansService) private readonly plans: StoragePlansService,
    @Inject(StorageAdminService) private readonly admin: StorageAdminService,
  ) {}

  @Get('storage-plans')
  @Header('Cache-Control', 'no-store')
  list() {
    return this.plans.list();
  }

  @Post('storage-plans')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(planSchema)) b: PlanDto) {
    return this.plans.create(b);
  }

  @Patch('storage-plans/:id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(planUpdateSchema)) b: PlanUpdateDto) {
    return this.plans.update(id, b);
  }

  /** Las empresas con su cupo y su solicitud abierta (con `only_requests=true`, solo las que piden espacio). */
  @Get('storage-requests')
  @Header('Cache-Control', 'no-store')
  requests(@Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.admin.companiesSpace({ onlyRequests: q.only_requests !== 'false', q: q.q });
  }

  @Get('storage-companies')
  @Header('Cache-Control', 'no-store')
  companies(@Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.admin.companiesSpace({ onlyRequests: q.only_requests === 'true', q: q.q });
  }

  @Get('companies/:id/storage-grants')
  @Header('Cache-Control', 'no-store')
  grants(@Param('id', idParam) id: string) {
    return this.admin.grants(id);
  }

  @Post('companies/:id/storage-grants')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  grant(@Param('id', idParam) id: string, @Headers('idempotency-key') key: string | undefined, @Body(new ZodValidationPipe(grantSchema)) b: GrantDto) {
    return this.admin.grant(id, b, keyOf(key));
  }

  @Post('companies/:id/storage-grants/:grantId/revoke')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  revoke(@Param('id', idParam) id: string, @Param('grantId', idParam) grantId: string, @Body(new ZodValidationPipe(revokeSchema)) b: RevokeDto) {
    return this.admin.revoke(id, grantId, b);
  }

  @Post('companies/:id/storage-request/dismiss')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  dismiss(@Param('id', idParam) id: string) {
    return this.admin.dismissRequest(id);
  }
}
