import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { Database, ghlRoutes } from '../../db';
import { TenantContext } from '../../tenant';
import { AuditService } from '../audit';
import type { EndpointStatus } from './attribution-endpoints.service';

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
/** Hash de relleno: una id desconocida cuesta lo mismo que un secreto equivocado (no se distingue por tiempo). */
const DUMMY_HASH = sha256('sin-ruta-ghl');
/** `last_used_at` se actualiza como mucho una vez por minuto (no una escritura de identidad por llamada). */
const TOUCH_EVERY_MS = 60_000;

/**
 * Punto de entrada del webhook de GoHighLevel de cada empresa (M7.1, ADR-52). Tabla de IDENTIDAD: el Workflow de GHL llega sin sesión y hay que saber de qué empresa es antes de que exista
 * contexto. El secreto se guarda solo como hash SHA-256 y se entrega UNA vez al generarlo o rotarlo. La empresa de `status`/`issue` sale siempre de `TenantContext`; `resolve` recibe lo que
 * manda el Workflow y devuelve la empresa o null (sin distinguir la causa).
 */
@Injectable()
export class GhlRoutesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async status(): Promise<EndpointStatus> {
    const org = TenantContext.current().organizationId;
    const [row] = await this.db.withIdentity((tx) => tx.select().from(ghlRoutes).where(eq(ghlRoutes.organizationId, org)).limit(1));
    if (!row) return { configured: false, id: null, created_at: null, rotated_at: null, last_used_at: null };
    return { configured: true, id: row.id, created_at: row.createdAt.toISOString(), rotated_at: row.rotatedAt?.toISOString() ?? null, last_used_at: row.lastUsedAt?.toISOString() ?? null };
  }

  /** Crea el punto de entrada o ROTA su secreto (el anterior deja de servir al instante). Devuelve el secreto en claro esta única vez. */
  async issue(): Promise<{ id: string; secret: string; rotated: boolean }> {
    const c = TenantContext.current();
    const secret = `ghw_${randomBytes(32).toString('base64url')}`;
    const hash = sha256(secret);
    const out = await this.db.withIdentity(async (tx) => {
      const [cur] = await tx.select({ id: ghlRoutes.id }).from(ghlRoutes).where(eq(ghlRoutes.organizationId, c.organizationId)).limit(1);
      if (cur) {
        await tx.update(ghlRoutes).set({ secretHash: hash, rotatedAt: new Date() }).where(eq(ghlRoutes.id, cur.id));
        return { id: cur.id, rotated: true };
      }
      const id = randomUUID(); // v4: no secuencial ni derivado de la empresa
      await tx.insert(ghlRoutes).values({ id, organizationId: c.organizationId, secretHash: hash, createdBy: c.userId ?? null });
      return { id, rotated: false };
    });
    // Auditoría del cliente tras confirmar (la tabla es de identidad y vive en otro pool: ADR-33 #6). Nunca lleva el secreto.
    await this.audit.record({ entityType: 'ghl_webhook', entityId: out.id, field: out.rotated ? 'secret_rotated' : 'created', newValue: true, source: 'manual' });
    return { ...out, secret };
  }

  /** Empresa dueña de la ruta si el secreto es el vigente; null en cualquier otro caso (id inexistente, secreto distinto). */
  async resolve(id: string, secret: string, now = new Date()): Promise<string | null> {
    const [row] = await this.db.withIdentity((tx) => tx.select({ organizationId: ghlRoutes.organizationId, secretHash: ghlRoutes.secretHash }).from(ghlRoutes).where(eq(ghlRoutes.id, id)).limit(1));
    const expected = Buffer.from(row?.secretHash ?? DUMMY_HASH, 'hex');
    const given = Buffer.from(sha256(secret), 'hex');
    if (!row || !timingSafeEqual(expected, given)) return null;
    await this.db.withIdentity((tx) =>
      tx
        .update(ghlRoutes)
        .set({ lastUsedAt: now })
        .where(and(eq(ghlRoutes.id, id), or(isNull(ghlRoutes.lastUsedAt), lt(ghlRoutes.lastUsedAt, new Date(now.getTime() - TOUCH_EVERY_MS))))),
    );
    return row.organizationId;
  }
}
