import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { listAgencyClientsQuerySchema, type ListAgencyClientsQuery } from './agencies.dto';
import { AgencyClientsService } from './agency-clients.service';

/** «Mis clientes» de la agencia (tenant: la cartera sale del contexto). Registrar y reenviar invitaciones viven en `auth`, con las invitaciones. */
@RequirePermission('agency.clients.read')
@Controller('agency/clients')
export class AgencyClientsController {
  constructor(@Inject(AgencyClientsService) private readonly clients: AgencyClientsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query(new ZodValidationPipe(listAgencyClientsQuerySchema)) q: ListAgencyClientsQuery) {
    return this.clients.list(q);
  }
}
