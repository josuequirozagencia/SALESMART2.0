import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../../jobs/scheduled-job';
import { TenantContext } from '../../../tenant';
import { OrgDirectoryService } from '../../organizations';
import { KnowledgeProcessorService } from './knowledge-processor.service';

/**
 * Tarea periódica que procesa los documentos de la biblioteca (M8.2, ADR-53). Recorre las empresas CLIENTE y, para cada una, procesa sus documentos pendientes bajo SU contexto (la RLS impide ver los de otra).
 * Con muchas empresas habrá que cambiar el recorrido por una lista de «empresas con documentos pendientes» (hoy es una consulta barata por empresa cada 10 s).
 */
@Injectable()
export class KnowledgeJob implements ScheduledJob {
  readonly name = 'knowledge-documents';
  readonly intervalMs = 10_000;

  constructor(
    @Inject(KnowledgeProcessorService) private readonly processor: KnowledgeProcessorService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async run(now: Date): Promise<number> {
    let touched = 0;
    for (const organizationId of await this.directory.clientOrganizationIds()) {
      touched += await TenantContext.run({ organizationId }, () => this.processor.runDue(now));
    }
    return touched;
  }
}
