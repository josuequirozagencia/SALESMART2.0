import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { attributionEndpoints, Database, organizations } from '../../db';
import { TenantContext } from '../../tenant';
import { AuditService } from '../audit';

export interface EndpointStatus {
  configured: boolean;
  /** Identificador opaco de la URL. No es secreto: sin el secreto no se puede enviar nada. */
  id: string | null;
  created_at: string | null;
  rotated_at: string | null;
  last_used_at: string | null;
}

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
/** Hash de relleno: una id desconocida cuesta lo mismo que un secreto equivocado (no se distingue por tiempo). */
const DUMMY_HASH = sha256('sin-punto-de-entrada');
/** `last_used_at` se actualiza como mucho una vez por minuto (no una escritura de identidad por llamada). */
const TOUCH_EVERY_MS = 60_000;

/**
 * Punto de entrada de la atribución de Meta Ads de cada empresa (M3.3, ADR-45). Es una tabla de IDENTIDAD porque el webhook llega sin sesión y hay que
 * saber de qué empresa es antes de que exista contexto. El secreto se guarda solo como hash SHA-256 y se entrega UNA vez al generarlo. La empresa de
 * `status`/`issue` sale siempre de `TenantContext`; `resolve` recibe lo que manda el webhook y devuelve la empresa o null (sin distinguir la causa).
 */
@Injectable()
export class AttributionEndpointsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async status(): Promise<EndpointStatus> {
    const org = TenantContext.current().organizationId;
    const [row] = await this.db.withIdentity((tx) => tx.select().from(attributionEndpoints).where(eq(attributionEndpoints.organizationId, org)).limit(1));
    if (!row) return { configured: false, id: null, created_at: null, rotated_at: null, last_used_at: null };
    return { configured: true, id: row.id, created_at: row.createdAt.toISOString(), rotated_at: row.rotatedAt?.toISOString() ?? null, last_used_at: row.lastUsedAt?.toISOString() ?? null };
  }

  /** Crea el punto de entrada o REGENERA su secreto (el anterior deja de servir al instante). Devuelve el secreto en claro esta única vez. */
  async issue(): Promise<{ id: string; secret: string; rotated: boolean }> {
    const c = TenantContext.current();
    const secret = `ssw_${randomBytes(32).toString('base64url')}`;
    const hash = sha256(secret);
    const out = await this.db.withIdentity(async (tx) => {
      const [cur] = await tx.select({ id: attributionEndpoints.id }).from(attributionEndpoints).where(eq(attributionEndpoints.organizationId, c.organizationId)).limit(1);
      if (cur) {
        await tx.update(attributionEndpoints).set({ secretHash: hash, rotatedAt: new Date() }).where(eq(attributionEndpoints.id, cur.id));
        return { id: cur.id, rotated: true };
      }
      const id = randomUUID(); // v4: no secuencial ni derivado de la empresa
      await tx.insert(attributionEndpoints).values({ id, organizationId: c.organizationId, secretHash: hash, createdBy: c.userId ?? null });
      return { id, rotated: false };
    });
    // Auditoría del cliente tras confirmar (la tabla es de identidad y vive en otro pool: ADR-33 #6). Nunca lleva el secreto.
    await this.audit.record({ entityType: 'attribution_endpoint', entityId: out.id, field: out.rotated ? 'secret_rotated' : 'created', newValue: true, source: 'manual' });
    return { ...out, secret };
  }

  /** Empresa dueña del punto de entrada si el secreto es el vigente; null en cualquier otro caso (id inexistente, secreto distinto). */
  async resolve(id: string, secret: string, now = new Date()): Promise<string | null> {
    const [row] = await this.db.withIdentity((tx) => tx.select({ organizationId: attributionEndpoints.organizationId, secretHash: attributionEndpoints.secretHash }).from(attributionEndpoints).where(eq(attributionEndpoints.id, id)).limit(1));
    const expected = Buffer.from(row?.secretHash ?? DUMMY_HASH, 'hex');
    const given = Buffer.from(sha256(secret), 'hex');
    if (!row || !timingSafeEqual(expected, given)) return null;
    await this.db.withIdentity((tx) =>
      tx
        .update(attributionEndpoints)
        .set({ lastUsedAt: now })
        .where(and(eq(attributionEndpoints.id, id), or(isNull(attributionEndpoints.lastUsedAt), lt(attributionEndpoints.lastUsedAt, new Date(now.getTime() - TOUCH_EVERY_MS))))),
    );
    return row.organizationId;
  }

  /** Empresas cliente activas (para el job de envío de eventos, que recorre una empresa a la vez bajo su propio contexto). */
  async activeClientOrgIds(): Promise<string[]> {
    const rows = await this.db.withIdentity((tx) => tx.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.kind, 'client'), eq(organizations.status, 'active'), isNull(organizations.deletedAt))));
    return rows.map((r) => r.id);
  }
}
