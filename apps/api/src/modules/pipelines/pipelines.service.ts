import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { Database, opportunities, pipelines, pipelineStages, stageHistory, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import {
  MAX_PIPELINES, MAX_STAGES, type CreatePipelineDto, type CreateStageDto, type OrderDto, type StageColor, type StageKind, type UpdatePipelineDto, type UpdateStageDto,
} from './pipelines.dto';

type PipelineRow = typeof pipelines.$inferSelect;
type StageRow = typeof pipelineStages.$inferSelect;

export interface StageView {
  id: string;
  name: string;
  position: number;
  kind: StageKind;
  is_hidden: boolean;
  color: StageColor;
  /** Oportunidades vigentes de la etapa que ESTA persona puede ver. */
  opportunity_count: number;
}
export interface PipelineView {
  id: string;
  name: string;
  position: number;
  appointment_stage_id: string | null;
  opportunity_count: number;
  stages: StageView[];
}

/** Quién consulta: con `contacts.view_all` cuenta todas las oportunidades; si no, solo las asignadas a la persona (ADR-43/49). */
export interface PipelineScope {
  readonly viewAll: boolean;
}

/** El pipeline que nace con cada empresa al primer uso (las etapas del prototipo). */
export const DEFAULT_PIPELINE = {
  name: 'Ventas',
  stages: [
    { name: 'Nuevo', kind: 'open', color: 'blue' },
    { name: 'Contactado', kind: 'open', color: 'teal' },
    { name: 'Calificado', kind: 'open', color: 'violet' },
    { name: 'Propuesta', kind: 'open', color: 'amber' },
    { name: 'Ganado', kind: 'won', color: 'green' },
  ],
} as const satisfies { name: string; stages: ReadonlyArray<{ name: string; kind: StageKind; color: StageColor }> };
const SIMPLE_STAGES: ReadonlyArray<{ name: string; kind: StageKind; color: StageColor }> = [
  { name: 'Nuevo', kind: 'open', color: 'blue' },
  { name: 'En seguimiento', kind: 'open', color: 'violet' },
  { name: 'Ganado', kind: 'won', color: 'green' },
];

const AUDIT = 'pipeline';
const AUDIT_STAGE = 'pipeline_stage';
const bad = (path: string, code: string, message: string): ValidationError => new ValidationError([{ path, code, message }]);

/**
 * Pipelines y etapas (M4.1, ADR-49). Configurar exige `pipelines.manage` (lo verifica el controlador). Las reglas de ADR-12/18 se aplican aquí y la base de datos
 * las respalda (una ganada por pipeline, nombres únicos). Todo cambio queda en la auditoría en la misma transacción. Las oportunidades llegan en M4.2; aquí solo
 * se las cuenta y, al eliminar una etapa abierta, se las mueve a la anterior.
 */
@Injectable()
export class PipelinesService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async list(scope: PipelineScope): Promise<{ items: PipelineView[] }> {
    return this.db.withTenant(async (tx) => {
      await this.ensureDefault(tx);
      return { items: await this.views(tx, scope) };
    });
  }

  async create(scope: PipelineScope, input: CreatePipelineDto): Promise<PipelineView> {
    return this.db
      .withTenant(async (tx) => {
        await this.lockOrg(tx);
        await this.ensureDefault(tx);
        const live = await tx.select({ n: sql<number>`count(*)::int`, max: sql<number | null>`max(${pipelines.position})` }).from(pipelines).where(isNull(pipelines.deletedAt));
        if ((live[0]?.n ?? 0) >= MAX_PIPELINES) throw new ConflictError('PIPELINE_LIMIT', `Se alcanzó el máximo de ${MAX_PIPELINES} pipelines. Borra alguno para crear otro`);
        const [row] = await tx.insert(pipelines).values({ name: input.name, position: (live[0]?.max ?? -1) + 1 }).returning();
        const stages = input.stages ?? SIMPLE_STAGES;
        await tx.insert(pipelineStages).values(stages.map((s, i) => ({ pipelineId: row!.id, name: s.name, position: i, kind: s.kind, color: s.color ?? DEFAULT_COLOR[s.kind] })));
        await writeAudit(tx, { entityType: AUDIT, entityId: row!.id, newValue: { name: row!.name, stages: stages.map((s) => s.name) }, source: 'manual' });
        return this.one(tx, scope, row!.id);
      })
      .catch((e: unknown) => {
        throw this.pipelineNameTaken(e) ?? this.stageNameTaken(e) ?? e;
      });
  }

  async update(scope: PipelineScope, id: string, input: UpdatePipelineDto): Promise<PipelineView> {
    return this.db
      .withTenant(async (tx) => {
        const cur = await this.lockPipeline(tx, id);
        const set: Partial<typeof pipelines.$inferInsert> = {};
        const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        if (input.name !== undefined && input.name !== cur.name) {
          set.name = input.name;
          changes.push({ field: 'name', oldValue: cur.name, newValue: input.name });
        }
        if (input.appointment_stage_id !== undefined && input.appointment_stage_id !== cur.appointmentStageId) {
          if (input.appointment_stage_id !== null) {
            const stage = (await this.stages(tx, id)).find((s) => s.id === input.appointment_stage_id);
            if (!stage) throw bad('appointment_stage_id', 'invalid_stage', 'La etapa de cita debe ser una etapa de este pipeline');
            if (stage.kind !== 'open') throw bad('appointment_stage_id', 'invalid_stage', 'La etapa de cita debe ser una etapa abierta');
          }
          set.appointmentStageId = input.appointment_stage_id;
          changes.push({ field: 'appointment_stage_id', oldValue: cur.appointmentStageId, newValue: input.appointment_stage_id });
        }
        if (changes.length > 0) await tx.update(pipelines).set({ ...set, updatedAt: new Date() }).where(eq(pipelines.id, id));
        for (const c of changes) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
        return this.one(tx, scope, id);
      })
      .catch((e: unknown) => {
        throw this.pipelineNameTaken(e) ?? e;
      });
  }

  /** Borrado lógico del pipeline y de sus etapas. No el último, ni uno con oportunidades. */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    return this.db.withTenant(async (tx) => {
      await this.lockOrg(tx);
      await this.lockPipeline(tx, id);
      const [others] = await tx.select({ n: sql<number>`count(*)::int` }).from(pipelines).where(and(isNull(pipelines.deletedAt), ne(pipelines.id, id)));
      if ((others?.n ?? 0) === 0) throw new ConflictError('PIPELINE_LAST', 'No se puede borrar el último pipeline: la empresa necesita al menos uno');
      const [opps] = await tx.select({ n: sql<number>`count(*)::int` }).from(opportunities).where(and(eq(opportunities.pipelineId, id), isNull(opportunities.deletedAt)));
      if ((opps?.n ?? 0) > 0) throw new ConflictError('PIPELINE_HAS_OPPORTUNITIES', 'Este pipeline tiene oportunidades. Muévelas o bórralas antes de borrarlo');
      const now = new Date();
      await tx.update(pipelineStages).set({ deletedAt: now, updatedAt: now }).where(and(eq(pipelineStages.pipelineId, id), isNull(pipelineStages.deletedAt)));
      await tx.update(pipelines).set({ deletedAt: now, updatedAt: now, appointmentStageId: null }).where(eq(pipelines.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'deleted', oldValue: false, newValue: true, source: 'manual' });
      return { id, deleted: true as const };
    });
  }

  /** `ids` debe ser EXACTAMENTE el conjunto de pipelines vigentes (si la pantalla quedó desactualizada, 409). */
  async reorder(scope: PipelineScope, input: OrderDto): Promise<{ items: PipelineView[] }> {
    return this.db.withTenant(async (tx) => {
      await this.lockOrg(tx);
      const live = await tx.select().from(pipelines).where(isNull(pipelines.deletedAt)).orderBy(asc(pipelines.position), asc(pipelines.id));
      if (live.length !== input.ids.length || !live.every((p) => input.ids.includes(p.id))) throw new ConflictError('PIPELINE_ORDER_STALE', 'La lista de pipelines cambió. Actualiza la pantalla e inténtalo de nuevo');
      const byId = new Map(live.map((p) => [p.id, p]));
      for (const [pos, id] of input.ids.entries()) {
        const cur = byId.get(id)!;
        if (cur.position === pos) continue;
        await tx.update(pipelines).set({ position: pos, updatedAt: new Date() }).where(eq(pipelines.id, id));
        await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'position', oldValue: cur.position, newValue: pos, source: 'manual' });
      }
      return { items: await this.views(tx, scope) };
    });
  }

  // ── etapas ───────────────────────────────────────────────────────────────

  async createStage(scope: PipelineScope, pipelineId: string, input: CreateStageDto): Promise<PipelineView> {
    return this.db
      .withTenant(async (tx) => {
        await this.lockPipeline(tx, pipelineId);
        const stages = await this.stages(tx, pipelineId);
        if (stages.length >= MAX_STAGES) throw new ConflictError('STAGE_LIMIT', `Un pipeline admite hasta ${MAX_STAGES} etapas`);
        if (input.kind === 'lost' && stages.some((s) => s.kind === 'lost')) throw new ConflictError('STAGE_KIND_TAKEN', 'Este pipeline ya tiene una etapa perdida');
        // Una etapa abierta nueva va justo antes de la ganada; la perdida, al final
        const won = stages.find((s) => s.kind === 'won');
        const at = input.kind === 'open' && won ? won.position : stages.length;
        const order = [...stages.map((s) => s.id)];
        const [row] = await tx.insert(pipelineStages).values({ pipelineId, name: input.name, position: stages.length, kind: input.kind, color: input.color ?? DEFAULT_COLOR[input.kind] }).returning();
        order.splice(at, 0, row!.id);
        await this.renumber(tx, order);
        await writeAudit(tx, { entityType: AUDIT_STAGE, entityId: row!.id, newValue: { pipeline_id: pipelineId, name: row!.name, kind: row!.kind, color: row!.color }, source: 'manual' });
        return this.one(tx, scope, pipelineId);
      })
      .catch((e: unknown) => {
        throw this.stageNameTaken(e) ?? e;
      });
  }

  async updateStage(scope: PipelineScope, id: string, input: UpdateStageDto): Promise<PipelineView> {
    return this.db
      .withTenant(async (tx) => {
        const cur = await this.lockStage(tx, id);
        const stages = await this.stages(tx, cur.pipelineId);
        const set: Partial<typeof pipelineStages.$inferInsert> = {};
        const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        const note = (field: string, oldValue: unknown, newValue: unknown): void => {
          changes.push({ field, oldValue, newValue });
        };
        if (input.name !== undefined && input.name !== cur.name) {
          set.name = input.name;
          note('name', cur.name, input.name);
        }
        if (input.color !== undefined && input.color !== cur.color) {
          set.color = input.color;
          note('color', cur.color, input.color);
        }
        let kind = cur.kind as StageKind;
        if (input.kind !== undefined && input.kind !== cur.kind) {
          kind = input.kind;
          await this.changeKind(tx, cur, stages, kind);
          set.kind = kind;
          note('kind', cur.kind, kind);
        }
        let hidden = cur.isHidden;
        if (input.is_hidden !== undefined && input.is_hidden !== cur.isHidden) {
          if (input.is_hidden && kind === 'won') throw new ConflictError('STAGE_WON_HIDDEN', 'La etapa ganada no se puede ocultar');
          hidden = input.is_hidden;
          note('is_hidden', cur.isHidden, hidden);
        }
        // Una etapa que pasa a ganada se muestra siempre
        if (kind === 'won' && hidden) {
          hidden = false;
          if (!changes.some((c) => c.field === 'is_hidden')) note('is_hidden', cur.isHidden, false);
        }
        if (hidden !== cur.isHidden) set.isHidden = hidden;
        if (changes.length > 0) await tx.update(pipelineStages).set({ ...set, updatedAt: new Date() }).where(eq(pipelineStages.id, id));
        for (const c of changes) await writeAudit(tx, { entityType: AUDIT_STAGE, entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
        return this.one(tx, scope, cur.pipelineId);
      })
      .catch((e: unknown) => {
        throw this.stageNameTaken(e) ?? e;
      });
  }

  /** Elimina una etapa (borrado lógico). Sus oportunidades pasan a la etapa ABIERTA anterior (o a la siguiente si era la primera). */
  async removeStage(scope: PipelineScope, id: string): Promise<PipelineView> {
    return this.db.withTenant(async (tx) => {
      const cur = await this.lockStage(tx, id);
      const stages = await this.stages(tx, cur.pipelineId);
      if (cur.kind === 'won') throw new ConflictError('STAGE_WON_REQUIRED', 'No se puede eliminar la etapa ganada. Marca otra etapa como ganada primero');
      const opens = stages.filter((s) => s.kind === 'open');
      if (cur.kind === 'open' && opens.length <= 1) throw new ConflictError('STAGE_LAST_OPEN', 'El pipeline necesita al menos una etapa abierta');
      const mine = await this.opportunityIds(tx, id);
      let moved = 0;
      if (mine.length > 0) {
        if (cur.kind === 'lost') throw new ConflictError('STAGE_HAS_CLOSED_OPPORTUNITIES', 'Esta etapa tiene oportunidades perdidas. Muévelas a otra etapa antes de eliminarla');
        const idx = stages.findIndex((s) => s.id === id);
        const target = [...stages.slice(0, idx)].reverse().find((s) => s.kind === 'open') ?? stages.slice(idx + 1).find((s) => s.kind === 'open');
        if (!target) throw new ConflictError('STAGE_LAST_OPEN', 'El pipeline necesita al menos una etapa abierta');
        const now = new Date();
        await tx.update(opportunities).set({ stageId: target.id, stageEnteredAt: now, updatedAt: now }).where(inArray(opportunities.id, mine));
        const actor = TenantContext.current().userId ?? null;
        await tx.insert(stageHistory).values(mine.map((opportunityId) => ({ opportunityId, fromStageId: id, toStageId: target.id, userId: actor, origin: 'system' })));
        moved = mine.length;
      }
      const now = new Date();
      await tx.update(pipelineStages).set({ deletedAt: now, updatedAt: now }).where(eq(pipelineStages.id, id));
      if ((await this.pipeline(tx, cur.pipelineId)).appointmentStageId === id) await tx.update(pipelines).set({ appointmentStageId: null, updatedAt: now }).where(eq(pipelines.id, cur.pipelineId));
      await this.renumber(tx, stages.filter((s) => s.id !== id).map((s) => s.id));
      await writeAudit(tx, { entityType: AUDIT_STAGE, entityId: id, field: 'deleted', oldValue: false, newValue: { deleted: true, moved_opportunities: moved }, source: 'manual' });
      return this.one(tx, scope, cur.pipelineId);
    });
  }

  /** `ids` debe ser EXACTAMENTE el conjunto de etapas vigentes del pipeline. */
  async reorderStages(scope: PipelineScope, pipelineId: string, input: OrderDto): Promise<PipelineView> {
    return this.db.withTenant(async (tx) => {
      await this.lockPipeline(tx, pipelineId);
      const stages = await this.stages(tx, pipelineId);
      if (stages.length !== input.ids.length || !stages.every((s) => input.ids.includes(s.id))) throw new ConflictError('STAGE_ORDER_STALE', 'Las etapas cambiaron. Actualiza la pantalla e inténtalo de nuevo');
      const byId = new Map(stages.map((s) => [s.id, s]));
      await this.renumber(tx, input.ids);
      for (const [pos, id] of input.ids.entries()) {
        const cur = byId.get(id)!;
        if (cur.position !== pos) await writeAudit(tx, { entityType: AUDIT_STAGE, entityId: id, field: 'position', oldValue: cur.position, newValue: pos, source: 'manual' });
      }
      return this.one(tx, scope, pipelineId);
    });
  }

  // ── reglas ───────────────────────────────────────────────────────────────

  /**
   * Cambia el tipo de una etapa (ADR-49 #3). Se rechaza si la etapa (o la que cedería su tipo) tiene oportunidades: primero se mueven. Una ganada nunca queda sin
   * ganada: para dejar de serlo se marca otra. El pipeline conserva siempre al menos una etapa abierta.
   */
  private async changeKind(tx: TenantTx, cur: StageRow, stages: StageRow[], next: StageKind): Promise<void> {
    if (cur.kind === 'won') throw new ConflictError('STAGE_WON_REQUIRED', 'La etapa ganada deja de serlo al marcar otra como ganada');
    if ((await this.opportunityIds(tx, cur.id)).length > 0) throw new ConflictError('STAGE_KIND_HAS_OPPORTUNITIES', 'Esta etapa tiene oportunidades. Muévelas a otra etapa antes de cambiar su tipo');
    if (next === 'open') return; // perdida → abierta: nada más que cambiar
    const holder = stages.find((s) => s.kind === next && s.id !== cur.id);
    // La que tenía el tipo (ganada o perdida) pasa a abierta, así que cuenta como abierta después del cambio
    const openAfter = stages.filter((s) => s.kind === 'open' && s.id !== cur.id).length + (holder ? 1 : 0);
    if (cur.kind === 'open' && openAfter === 0) throw new ConflictError('STAGE_LAST_OPEN', 'El pipeline necesita al menos una etapa abierta');
    if (holder) {
      if ((await this.opportunityIds(tx, holder.id)).length > 0) {
        throw new ConflictError('STAGE_KIND_HAS_OPPORTUNITIES', `La etapa «${holder.name}» ${next === 'won' ? 'es la ganada' : 'es la perdida'} y tiene oportunidades. Muévelas antes de cambiar cuál es la ${next === 'won' ? 'ganada' : 'perdida'}`);
      }
      await tx.update(pipelineStages).set({ kind: 'open', updatedAt: new Date() }).where(eq(pipelineStages.id, holder.id));
      await writeAudit(tx, { entityType: AUDIT_STAGE, entityId: holder.id, field: 'kind', oldValue: holder.kind, newValue: 'open', source: 'manual' });
    }
    // Una etapa de cita debe ser abierta
    const p = await this.pipeline(tx, cur.pipelineId);
    if (p.appointmentStageId === cur.id) {
      await tx.update(pipelines).set({ appointmentStageId: null, updatedAt: new Date() }).where(eq(pipelines.id, p.id));
      await writeAudit(tx, { entityType: AUDIT, entityId: p.id, field: 'appointment_stage_id', oldValue: cur.id, newValue: null, source: 'manual' });
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Crea el pipeline «Ventas» si la empresa no tiene ninguno (idempotente; candado por empresa). */
  async ensureDefault(tx: TenantTx): Promise<void> {
    const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(pipelines).where(isNull(pipelines.deletedAt));
    if ((n?.n ?? 0) > 0) return;
    await this.lockOrg(tx);
    const [again] = await tx.select({ n: sql<number>`count(*)::int` }).from(pipelines).where(isNull(pipelines.deletedAt));
    if ((again?.n ?? 0) > 0) return;
    const [row] = await tx.insert(pipelines).values({ name: DEFAULT_PIPELINE.name, position: 0 }).returning();
    await tx.insert(pipelineStages).values(DEFAULT_PIPELINE.stages.map((s, i) => ({ pipelineId: row!.id, name: s.name, position: i, kind: s.kind, color: s.color })));
    await writeAudit(tx, { entityType: AUDIT, entityId: row!.id, newValue: { name: row!.name, stages: DEFAULT_PIPELINE.stages.map((s) => s.name), default: true }, source: 'manual' });
  }

  private async lockOrg(tx: TenantTx): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(('pipelines:' || app_org()::text), 0))`);
  }

  /** El pipeline vigente, bloqueado; 404 si no existe (o es de otra organización: la RLS ya lo hizo invisible). */
  private async lockPipeline(tx: TenantTx, id: string): Promise<PipelineRow> {
    const [row] = await tx.select().from(pipelines).where(and(eq(pipelines.id, id), isNull(pipelines.deletedAt))).for('update').limit(1);
    if (!row) throw new NotFoundError();
    return row;
  }

  private async pipeline(tx: TenantTx, id: string): Promise<PipelineRow> {
    const [row] = await tx.select().from(pipelines).where(eq(pipelines.id, id)).limit(1);
    return row!;
  }

  /** La etapa vigente, tras bloquear su pipeline (mismo orden de candados en todas las operaciones). */
  private async lockStage(tx: TenantTx, id: string): Promise<StageRow> {
    const [probe] = await tx.select().from(pipelineStages).where(and(eq(pipelineStages.id, id), isNull(pipelineStages.deletedAt))).limit(1);
    if (!probe) throw new NotFoundError();
    await this.lockPipeline(tx, probe.pipelineId);
    const [row] = await tx.select().from(pipelineStages).where(and(eq(pipelineStages.id, id), isNull(pipelineStages.deletedAt))).for('update').limit(1);
    if (!row) throw new NotFoundError();
    return row;
  }

  private stages(tx: TenantTx, pipelineId: string): Promise<StageRow[]> {
    return tx.select().from(pipelineStages).where(and(eq(pipelineStages.pipelineId, pipelineId), isNull(pipelineStages.deletedAt))).orderBy(asc(pipelineStages.position), asc(pipelineStages.id));
  }

  /** Deja las posiciones en 0..n-1 según el orden dado. */
  private async renumber(tx: TenantTx, orderedIds: readonly string[]): Promise<void> {
    for (const [pos, id] of orderedIds.entries()) await tx.update(pipelineStages).set({ position: pos, updatedAt: new Date() }).where(and(eq(pipelineStages.id, id), ne(pipelineStages.position, pos)));
  }

  private async opportunityIds(tx: TenantTx, stageId: string): Promise<string[]> {
    const rows = await tx.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.stageId, stageId), isNull(opportunities.deletedAt)));
    return rows.map((r) => r.id);
  }

  private async one(tx: TenantTx, scope: PipelineScope, id: string): Promise<PipelineView> {
    return (await this.views(tx, scope)).find((p) => p.id === id) ?? Promise.reject(new NotFoundError());
  }

  /** Todos los pipelines vigentes con sus etapas y el número de oportunidades que la persona puede ver en cada una. */
  private async views(tx: TenantTx, scope: PipelineScope): Promise<PipelineView[]> {
    const userId = TenantContext.current().userId;
    if (!userId) throw new ForbiddenError();
    const ps = await tx.select().from(pipelines).where(isNull(pipelines.deletedAt)).orderBy(asc(pipelines.position), asc(pipelines.id));
    const ss = await tx.select().from(pipelineStages).where(isNull(pipelineStages.deletedAt)).orderBy(asc(pipelineStages.position), asc(pipelineStages.id));
    const visible = scope.viewAll ? sql`true` : eq(opportunities.ownerId, userId);
    const counts = await tx
      .select({ stageId: opportunities.stageId, n: sql<number>`count(*)::int` })
      .from(opportunities)
      .where(and(isNull(opportunities.deletedAt), visible))
      .groupBy(opportunities.stageId);
    const byStage = new Map(counts.map((c) => [c.stageId, c.n]));
    return ps.map((p) => {
      const stages = ss
        .filter((s) => s.pipelineId === p.id)
        .map((s) => ({ id: s.id, name: s.name, position: s.position, kind: s.kind as StageKind, is_hidden: s.isHidden, color: s.color as StageColor, opportunity_count: byStage.get(s.id) ?? 0 }));
      return { id: p.id, name: p.name, position: p.position, appointment_stage_id: p.appointmentStageId, opportunity_count: stages.reduce((n, s) => n + s.opportunity_count, 0), stages };
    });
  }

  private pipelineNameTaken(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'pipelines_org_name_uq' ? new ConflictError('PIPELINE_EXISTS', 'Ya existe un pipeline con ese nombre') : undefined;
  }

  private stageNameTaken(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'pipeline_stages_name_uq' ? new ConflictError('STAGE_EXISTS', 'Ya existe una etapa con ese nombre en este pipeline') : undefined;
  }
}

const DEFAULT_COLOR: Record<StageKind, StageColor> = { open: 'blue', won: 'green', lost: 'red' };
