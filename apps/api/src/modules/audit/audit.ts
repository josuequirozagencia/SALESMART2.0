import { auditLogs, type TenantTx } from '../../db';
import { isSensitiveKey } from '../../logger';
import { TenantContext } from '../../tenant';

export type AuditSource = 'manual' | 'ai' | 'automation' | 'ghl' | 'meta' | 'api';

export interface AuditEntry {
  entityType: string;
  entityId: string;
  /** Campo modificado (null = acción sobre la entidad completa: crear, borrar, exportar…). */
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  source?: AuditSource;
}

const REDACTED_VALUE = { redacted: true } as const;

/**
 * Registra una entrada en `audit_logs` DENTRO de la transacción del llamador (misma atomicidad que el cambio auditado:
 * si la operación se revierte, la auditoría también). El actor, `acting_as`, `acting_org_id` y la organización salen del
 * TenantContext (nunca del llamador). Si el campo es sensible (contraseña, token, secreto…) los valores NO se guardan.
 */
export async function writeAudit(tx: TenantTx, e: AuditEntry): Promise<void> {
  const c = TenantContext.current();
  const sensitive = e.field !== undefined && isSensitiveKey(e.field) === 'secret';
  await tx.insert(auditLogs).values({
    entityType: e.entityType,
    entityId: e.entityId,
    field: e.field ?? null,
    oldValue: sensitive ? REDACTED_VALUE : (e.oldValue ?? null),
    newValue: sensitive ? REDACTED_VALUE : (e.newValue ?? null),
    actorUserId: c.userId ?? null,
    actingAs: c.actingAs ?? null,
    actingOrgId: c.actingOrgId ?? null,
    source: e.source ?? 'manual',
    requestId: c.requestId,
  });
}
