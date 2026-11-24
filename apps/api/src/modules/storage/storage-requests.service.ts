import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { Database, storageRequests, type TenantTx } from '../../db';
import { ConflictError, NotFoundError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { StoragePlansService, type PublicPlanView, type RequestDto, type RequestView } from '../platform';

type Row = typeof storageRequests.$inferSelect;
export const requestView = (r: Row): RequestView => ({ id: r.id, plan_id: r.requestedPlanId, plan_name: r.planName, status: r.status as RequestView['status'], note: r.note, created_at: r.createdAt.toISOString() });

/** La solicitud abierta de la empresa del contexto, si la hay. */
export async function openRequestIn(tx: TenantTx): Promise<RequestView | null> {
  const [r] = await tx.select().from(storageRequests).where(eq(storageRequests.status, 'open')).orderBy(desc(storageRequests.createdAt)).limit(1);
  return r ? requestView(r) : null;
}

/**
 * Solicitudes de más espacio (V21b, ADR-75): el administrador de la empresa le pide espacio al Súper Admin. Una sola abierta por empresa. Cobrar y activar el plan lo hace el Súper Admin a mano
 * (no hay pasarela). Nada de esto toca los archivos ni el cupo: solo deja constancia.
 */
@Injectable()
export class StorageRequestsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(StoragePlansService) private readonly plans: StoragePlansService,
  ) {}

  /** Los planes activos, con su precio de lista, y la solicitud abierta de esta empresa. */
  async options(): Promise<{ plans: PublicPlanView[]; request: RequestView | null }> {
    const plans = await this.plans.activeForClients(); // antes de abrir la transacción de la empresa
    const request = await this.db.withTenant((tx) => openRequestIn(tx));
    return { plans, request };
  }

  async create(b: RequestDto): Promise<RequestView> {
    const userId = TenantContext.current().userId ?? null;
    const plan = b.plan_id ? (await this.plans.activeForClients()).find((p) => p.id === b.plan_id) : undefined;
    if (b.plan_id && !plan) throw new NotFoundError(); // un plan inexistente o ya no activo
    try {
      return await this.db.withTenant(async (tx) => {
        const [row] = await tx.insert(storageRequests).values({ requestedPlanId: plan?.id ?? null, planName: plan?.name ?? null, note: b.note ? b.note : null, requestedBy: userId }).returning();
        await writeAudit(tx, { entityType: 'storage_request', entityId: row!.id, newValue: { plan: plan?.name ?? null }, source: 'manual' });
        return requestView(row!);
      });
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code === '23505') throw new ConflictError('REQUEST_ALREADY_OPEN', 'Ya hay una solicitud de espacio abierta: el equipo la está revisando');
      throw e;
    }
  }

  /** Cierra la solicitud abierta (la concesión de espacio la marca como atendida). Dentro de la transacción de quien llama. */
  async resolveOpen(tx: TenantTx, status: 'granted' | 'dismissed', resolvedBy: string | null): Promise<string | null> {
    const [r] = await tx
      .update(storageRequests)
      .set({ status, resolvedBy, resolvedAt: new Date() })
      .where(and(eq(storageRequests.status, 'open')))
      .returning({ id: storageRequests.id });
    return r?.id ?? null;
  }
}
