import { Inject, Injectable } from '@nestjs/common';
import { Database, platformAudit } from '../../db';
import { isSensitiveKey } from '../../logger';
import { PlatformContext } from '../../tenant';

export interface PlatformAuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  targetOrgId?: string;
  /** Detalles no sensibles. Las claves sensibles (contraseña, token, secreto…) se descartan antes de guardar. */
  details?: Record<string, unknown>;
}

/** Auditoría de PLATAFORMA (rol app_platform, append-only). Requiere PlatformContext; el actor sale de él. */
@Injectable()
export class PlatformAuditService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async record(e: PlatformAuditEntry): Promise<void> {
    const c = PlatformContext.current();
    const details = e.details ? Object.fromEntries(Object.entries(e.details).filter(([k]) => isSensitiveKey(k) !== 'secret')) : null;
    return this.db.withPlatform(async (tx) => {
      await tx.insert(platformAudit).values({
        action: e.action,
        entityType: e.entityType ?? null,
        entityId: e.entityId ?? null,
        actorUserId: c.actorUserId,
        targetOrgId: e.targetOrgId ?? null,
        details,
        requestId: c.requestId,
      });
    });
  }
}
