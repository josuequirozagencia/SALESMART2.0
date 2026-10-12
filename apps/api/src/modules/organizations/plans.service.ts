import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { Database, plans } from '../../db';
import { ConflictError, NotFoundError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { PlatformAuditService } from '../platform';
import type { CreatePlanDto, UpdatePlanDto } from './plans.dto';
import { normalizeFeatures, PLAN_FEATURES, type PlanFeatureKey } from './plan-features';

type PlanRow = typeof plans.$inferSelect;

export interface PlanView {
  id: string;
  name: string;
  description: string | null;
  max_users: number | null;
  max_connections: number | null;
  max_queues: number | null;
  features: Record<PlanFeatureKey, boolean>;
  archived: boolean;
  created_at: string;
  updated_at: string;
  /** Empresas que usan el plan hoy. */
  companies: number;
}

export interface PlanList {
  items: PlanView[];
  feature_catalog: ReadonlyArray<{ key: PlanFeatureKey; label: string }>;
}

export function pgError(e: unknown): { code?: string; constraint?: string } {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    const c = cur as { code?: string; constraint?: string; cause?: unknown };
    if (c.code) return { code: c.code, ...(c.constraint ? { constraint: c.constraint } : {}) };
    cur = c.cause;
  }
  return {};
}
const nameTaken = (): ConflictError => new ConflictError('PLAN_NAME_TAKEN', 'Ya existe un plan con ese nombre');

const view = (p: PlanRow, companies: number): PlanView => ({
  id: p.id,
  name: p.name,
  description: p.description,
  max_users: p.maxUsers,
  max_connections: p.maxConnections,
  max_queues: p.maxQueues,
  features: normalizeFeatures(p.features),
  archived: p.archivedAt !== null,
  created_at: p.createdAt.toISOString(),
  updated_at: p.updatedAt.toISOString(),
  companies,
});

/**
 * Catálogo de planes (M2.2, ADR-38). Solo el Súper Admin (permiso `platform.plans.manage`). Sin precios (se definen aparte).
 *  - Un plan en uso NO se archiva (409 con el número de empresas): primero se reasigna.
 *  - Las mutaciones bloquean la fila del plan (`FOR UPDATE`); asignar un plan toma el mismo bloqueo (`FOR SHARE`), así archivar y
 *    asignar a la vez nunca dejan una empresa con un plan archivado.
 *  - Auditoría en `platform_audit` después del commit (el rol de identidad no escribe esa tabla; ver ADR-33 #6).
 */
@Injectable()
export class PlansService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async list(includeArchived: boolean): Promise<PlanList> {
    const rows = await this.db.withIdentity(async (tx) => {
      const res = await tx.execute<{ id: string; companies: number }>(
        sql`SELECT p.id, (SELECT count(*)::int FROM organizations o WHERE o.plan_id = p.id AND o.deleted_at IS NULL) AS companies FROM plans p`,
      );
      const counts = new Map(res.rows.map((r) => [r.id, Number(r.companies)]));
      const all = await tx.select().from(plans).orderBy(plans.createdAt, plans.id);
      return all.map((p) => ({ p, n: counts.get(p.id) ?? 0 }));
    });
    return { items: rows.filter((r) => includeArchived || r.p.archivedAt === null).map((r) => view(r.p, r.n)), feature_catalog: PLAN_FEATURES };
  }

  async create(dto: CreatePlanDto): Promise<PlanView> {
    let row: PlanRow;
    try {
      row = await this.db.withIdentity(async (tx) => {
        const [p] = await tx
          .insert(plans)
          .values({ name: dto.name, description: dto.description ?? null, maxUsers: dto.max_users ?? null, maxConnections: dto.max_connections ?? null, maxQueues: dto.max_queues ?? null, features: normalizeFeatures(dto.features) })
          .returning();
        return p!;
      });
    } catch (e) {
      if (pgError(e).code === '23505') throw nameTaken();
      throw e;
    }
    await this.record('plan.created', row, { name: row.name });
    return view(row, 0);
  }

  async update(id: string, dto: UpdatePlanDto): Promise<PlanView> {
    let out: { row: PlanRow; companies: number };
    try {
      out = await this.db.withIdentity(async (tx) => {
        const [cur] = await tx.select().from(plans).where(eq(plans.id, id)).for('update').limit(1);
        if (!cur) throw new NotFoundError();
        if (cur.archivedAt) throw new ConflictError('PLAN_ARCHIVED', 'Un plan archivado no se edita: restáuralo primero');
        const features = dto.features ? { ...normalizeFeatures(cur.features), ...dto.features } : normalizeFeatures(cur.features);
        const [upd] = await tx
          .update(plans)
          .set({
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.description !== undefined ? { description: dto.description } : {}),
            ...(dto.max_users !== undefined ? { maxUsers: dto.max_users } : {}),
            ...(dto.max_connections !== undefined ? { maxConnections: dto.max_connections } : {}),
            ...(dto.max_queues !== undefined ? { maxQueues: dto.max_queues } : {}),
            features,
            updatedAt: new Date(),
          })
          .where(eq(plans.id, id))
          .returning();
        const res = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM organizations WHERE plan_id = ${id} AND deleted_at IS NULL`);
        return { row: upd!, companies: Number(res.rows[0]?.n ?? 0) };
      });
    } catch (e) {
      if (pgError(e).code === '23505') throw nameTaken();
      throw e;
    }
    await this.record('plan.updated', out.row, { fields: Object.keys(dto) });
    return view(out.row, out.companies);
  }

  /** Archivar (plan fuera de uso) o restaurar. No se borra nunca. */
  async setArchived(id: string, archived: boolean): Promise<PlanView> {
    const out = await this.db.withIdentity(async (tx) => {
      const [cur] = await tx.select().from(plans).where(eq(plans.id, id)).for('update').limit(1);
      if (!cur) throw new NotFoundError();
      const res = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM organizations WHERE plan_id = ${id} AND deleted_at IS NULL`);
      const companies = Number(res.rows[0]?.n ?? 0);
      if (archived && companies > 0) throw new ConflictError('PLAN_IN_USE', `El plan lo usan ${companies} empresa${companies === 1 ? '' : 's'}: reasígnalas antes de archivarlo`);
      const now = new Date();
      const [upd] = await tx.update(plans).set({ archivedAt: archived ? (cur.archivedAt ?? now) : null, updatedAt: now }).where(eq(plans.id, id)).returning();
      return { row: upd!, companies };
    });
    await this.record(archived ? 'plan.archived' : 'plan.restored', out.row, { name: out.row.name });
    return view(out.row, out.companies);
  }

  private async record(action: string, row: PlanRow, details: Record<string, unknown>): Promise<void> {
    try {
      await this.audit.record({ action, entityType: 'plan', entityId: row.id, details });
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, `auditoría ${action} falló (la operación ya está confirmada)`);
    }
  }
}
