import { Inject, Injectable } from '@nestjs/common';
import { TenantContext } from '../../tenant';
import type { ListAgencyClientsQuery } from './agencies.dto';
import { CompaniesService, type CompanyList } from './companies.service';

/**
 * «Mis clientes» (F02, ADR-41): la cartera de la agencia del CONTEXTO verificado. La agencia sale de `TenantContext` (nunca de la petición), de modo
 * que ninguna combinación de parámetros muestra clientes de otra agencia. Mismos estados derivados que la lista de la plataforma, sin contenido de
 * negocio de los clientes (ADR-11: solo lo que la agencia necesita para administrar y entrar).
 */
@Injectable()
export class AgencyClientsService {
  constructor(@Inject(CompaniesService) private readonly companies: CompaniesService) {}

  list(f: ListAgencyClientsQuery): Promise<CompanyList> {
    return this.companies.list({ limit: f.limit, ...(f.q ? { q: f.q } : {}), ...(f.state ? { state: f.state } : {}), ...(f.cursor ? { cursor: f.cursor } : {}) }, new Date(), { agencyId: TenantContext.current().organizationId });
  }
}
