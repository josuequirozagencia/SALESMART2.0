import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../db';
import { writeAudit, type AuditEntry } from './audit';

/** Auditoría del cliente. Preferir `writeAudit(tx, …)` dentro de la transacción del cambio; `record` abre la suya (acciones sin escritura propia). */
@Injectable()
export class AuditService {
  constructor(@Inject(Database) private readonly db: Database) {}

  record(entry: AuditEntry): Promise<void> {
    return this.db.withTenant((tx) => writeAudit(tx, entry));
  }
}
