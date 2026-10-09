import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { Database, organizations, trialConfig, trials, users, type IdentityTx } from '../../db';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../errors';
import type { Principal } from '../../http';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { AuditService } from '../audit';
import { PlatformAuditService } from '../platform';
import { canRequestExtension, extendedEnd, isTrialExpired, type ExtensionStatus } from './trial.domain';

type TrialRow = typeof trials.$inferSelect;

/** Vista de la prueba para el propio cliente (sin datos de otras organizaciones ni del Súper Admin). */
export interface TrialView {
  status: 'active' | 'expired';
  started_at: string;
  ends_at: string;
  extension: { status: ExtensionStatus; can_request: boolean; requested_at: string | null; decided_at: string | null; days_granted: number | null };
}

export interface PlatformTrialItem extends Omit<TrialView, 'extension'> {
  id: string;
  organization_id: string;
  organization_name: string;
  owner_email: string;
  extension: TrialView['extension'] & { reason: string | null };
}

export interface PlatformTrialList {
  items: PlatformTrialItem[];
  next_cursor: string | null;
  /** Insignia de navegación (ADR-23 #3): solicitudes de extensión pendientes en toda la plataforma. */
  pending_extensions: number;
}

export interface PlatformTrialFilter {
  extension?: ExtensionStatus | undefined;
  state?: 'active' | 'expired' | undefined;
  limit: number;
  cursor?: string | undefined;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function viewOf(r: TrialRow, now: Date): TrialView {
  return {
    status: isTrialExpired(r, now) ? 'expired' : 'active',
    started_at: r.startedAt.toISOString(),
    ends_at: r.endsAt.toISOString(),
    extension: {
      status: r.extStatus as ExtensionStatus,
      can_request: canRequestExtension(r.extStatus as ExtensionStatus),
      requested_at: iso(r.extRequestedAt),
      decided_at: iso(r.extDecidedAt),
      days_granted: r.extDaysGranted,
    },
  };
}

/**
 * Pruebas gratuitas (M1.5, ADR-23/ADR-33). Todo el acceso a datos pasa por `withIdentity` (rol app_identity):
 *  - el alta ocurre en la MISMA transacción que la verificación del correo (`startFor`);
 *  - toda mutación bloquea la fila (`FOR UPDATE`) y el trigger de BD impide transiciones ilegales de la extensión;
 *  - la organización sale siempre del principal verificado, nunca de la petición.
 * La auditoría se escribe DESPUÉS del commit (otro rol/pool: identidad no puede escribir audit_logs ni platform_audit);
 * el hecho queda además en la propia fila (quién, cuándo, qué) y un fallo de auditoría se registra sin deshacer la decisión.
 */
@Injectable()
export class TrialsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PlatformAuditService) private readonly platformAudit: PlatformAuditService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Crea la prueba de una organización recién verificada. Se llama DENTRO de la transacción de verificación. */
  async startFor(tx: IdentityTx, input: { organizationId: string; ownerUserId: string }, now: Date): Promise<void> {
    const cfg = await this.config(tx);
    await tx.insert(trials).values({
      organizationId: input.organizationId,
      ownerUserId: input.ownerUserId,
      startedAt: now,
      endsAt: new Date(now.getTime() + cfg.days * 86_400_000),
    });
  }

  /** Prueba de la organización del principal VERIFICADO. 404 si no tiene (Súper Admin, agencia, cliente de pago futuro). */
  async mine(principal: Principal | undefined, now = new Date()): Promise<TrialView> {
    const org = this.tenantOf(principal);
    const [r] = await this.db.withIdentity((tx) => tx.select().from(trials).where(eq(trials.organizationId, org)).limit(1));
    if (!r) throw new NotFoundError();
    return viewOf(r, now);
  }

  /** Alta de la solicitud de extensión de la organización del principal verificado. */
  requestMine(principal: Principal | undefined, reason: string, now = new Date()): Promise<TrialView> {
    if (principal?.kind !== 'tenant') throw new UnauthorizedError();
    return this.requestExtension({ organizationId: principal.organizationId, reason }, now);
  }

  /** Solicita la ÚNICA extensión de la cuenta (none → pending). Cualquier otro estado previo → 409. */
  async requestExtension(input: { organizationId: string; reason: string }, now = new Date()): Promise<TrialView> {
    const res = await this.db.withIdentity(async (tx) => {
      const [row] = await tx.select().from(trials).where(eq(trials.organizationId, input.organizationId)).for('update').limit(1);
      if (!row) throw new NotFoundError();
      if (!canRequestExtension(row.extStatus as ExtensionStatus)) throw new ConflictError('EXTENSION_ALREADY_USED', 'Esta cuenta ya solicitó su extensión');
      const [upd] = await tx
        .update(trials)
        .set({ extStatus: 'pending', extReason: input.reason, extRequestedAt: now, updatedAt: now })
        .where(and(eq(trials.id, row.id), eq(trials.extStatus, 'none')))
        .returning();
      if (!upd) throw new ConflictError('EXTENSION_ALREADY_USED', 'Esta cuenta ya solicitó su extensión');
      return upd;
    });
    await this.safely('auditoría de la solicitud de extensión', () =>
      this.audit.record({ entityType: 'trial', entityId: res.id, field: 'extension', oldValue: { status: 'none' }, newValue: { status: 'pending' }, source: 'manual' }),
    );
    return viewOf(res, now);
  }

  /** Lista para la consola de plataforma, paginada por cursor (id v7 descendente = más recientes primero). */
  async list(f: PlatformTrialFilter, now = new Date()): Promise<PlatformTrialList> {
    return this.db.withIdentity(async (tx) => {
      const conds = [
        f.cursor ? lt(trials.id, f.cursor) : undefined,
        f.extension ? eq(trials.extStatus, f.extension) : undefined,
        f.state === 'expired' ? sql`(${trials.status} = 'expired' OR ${trials.endsAt} <= ${now})` : undefined,
        f.state === 'active' ? sql`(${trials.status} = 'active' AND ${trials.endsAt} > ${now})` : undefined,
      ].filter((c) => c !== undefined);
      const rows = await tx
        .select({ t: trials, orgName: organizations.name, ownerEmail: users.email })
        .from(trials)
        .innerJoin(organizations, eq(organizations.id, trials.organizationId))
        .innerJoin(users, eq(users.id, trials.ownerUserId))
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(desc(trials.id))
        .limit(f.limit + 1);
      const [pending] = await tx.select({ n: sql<number>`count(*)::int` }).from(trials).where(eq(trials.extStatus, 'pending'));
      const page = rows.slice(0, f.limit);
      return {
        items: page.map((r) => {
          const v = viewOf(r.t, now);
          return { id: r.t.id, organization_id: r.t.organizationId, organization_name: r.orgName, owner_email: r.ownerEmail, status: v.status, started_at: v.started_at, ends_at: v.ends_at, extension: { ...v.extension, reason: r.t.extReason } };
        }),
        next_cursor: rows.length > f.limit ? (page[page.length - 1]?.t.id ?? null) : null,
        pending_extensions: pending?.n ?? 0,
      };
    });
  }

  /** pending → approved. Antes de vencer suma al fin vigente; ya vencida, cuenta desde ahora y se reactiva (ADR-23 #4). */
  async approve(input: { trialId: string; actorUserId: string }, now = new Date()): Promise<TrialView> {
    const res = await this.db.withIdentity(async (tx) => {
      const row = await this.lockPending(tx, input.trialId);
      const cfg = await this.config(tx);
      const [upd] = await tx
        .update(trials)
        .set({
          extStatus: 'approved',
          extDecidedBy: input.actorUserId,
          extDecidedAt: now,
          extDaysGranted: cfg.extensionDays,
          endsAt: extendedEnd(row.endsAt, now, cfg.extensionDays),
          status: 'active',
          expiredAt: null,
          updatedAt: now,
        })
        .where(and(eq(trials.id, row.id), eq(trials.extStatus, 'pending')))
        .returning();
      if (!upd) throw new ConflictError('EXTENSION_NOT_PENDING', 'La solicitud ya fue resuelta');
      return upd;
    });
    await this.auditDecision('trial.extension_approved', res, { days_granted: res.extDaysGranted });
    return viewOf(res, now);
  }

  /** pending → denied. No cambia el fin de la prueba. */
  async deny(input: { trialId: string; actorUserId: string }, now = new Date()): Promise<TrialView> {
    const res = await this.db.withIdentity(async (tx) => {
      const row = await this.lockPending(tx, input.trialId);
      const [upd] = await tx
        .update(trials)
        .set({ extStatus: 'denied', extDecidedBy: input.actorUserId, extDecidedAt: now, updatedAt: now })
        .where(and(eq(trials.id, row.id), eq(trials.extStatus, 'pending')))
        .returning();
      if (!upd) throw new ConflictError('EXTENSION_NOT_PENDING', 'La solicitud ya fue resuelta');
      return upd;
    });
    await this.auditDecision('trial.extension_denied', res, {});
    return viewOf(res, now);
  }

  /**
   * Materializa el vencimiento (job). Lotes con `FOR UPDATE SKIP LOCKED`: varias instancias pueden correr a la vez sin
   * pisarse ni esperarse, y una prueba que se está decidiendo (bloqueada) se salta y se reintenta en la siguiente vuelta.
   * El UPDATE repite la condición: si una aprobación extendió el fin entre el SELECT y el UPDATE, no se vence.
   */
  async expireDue(now: Date, batchSize: number): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.db.withIdentity(async (tx) => {
        const picked = await tx
          .select({ id: trials.id })
          .from(trials)
          .where(and(eq(trials.status, 'active'), sql`${trials.endsAt} <= ${now}`))
          .orderBy(trials.endsAt)
          .limit(batchSize)
          .for('update', { skipLocked: true });
        if (picked.length === 0) return { picked: 0, expired: 0 };
        const done = await tx
          .update(trials)
          .set({ status: 'expired', expiredAt: now, updatedAt: now })
          .where(and(inArray(trials.id, picked.map((p) => p.id)), eq(trials.status, 'active'), sql`${trials.endsAt} <= ${now}`))
          .returning({ id: trials.id });
        return { picked: picked.length, expired: done.length };
      });
      total += batch.expired;
      if (batch.picked < batchSize) return total; // lote incompleto: ya no queda nada vencido que no esté bloqueado
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private tenantOf(principal: Principal | undefined): string {
    if (!principal) throw new UnauthorizedError();
    if (principal.kind !== 'tenant') throw new NotFoundError(); // el Súper Admin no tiene prueba
    return principal.organizationId;
  }

  private async lockPending(tx: IdentityTx, trialId: string): Promise<TrialRow> {
    const [row] = await tx.select().from(trials).where(eq(trials.id, trialId)).for('update').limit(1);
    if (!row) throw new NotFoundError();
    if (row.extStatus !== 'pending') throw new ConflictError('EXTENSION_NOT_PENDING', 'La solicitud ya fue resuelta o no existe');
    return row;
  }

  private async config(tx: IdentityTx): Promise<{ days: number; extensionDays: number; retentionDays: number }> {
    const [c] = await tx.select().from(trialConfig).limit(1);
    if (!c) throw new Error('trial_config sin fila: la migración 0012 la siembra'); // no es un error del cliente
    return c;
  }

  private auditDecision(action: string, row: TrialRow, details: Record<string, unknown>): Promise<void> {
    return this.safely(`auditoría ${action}`, () => this.platformAudit.record({ action, entityType: 'trial', entityId: row.id, targetOrgId: row.organizationId, details }));
  }

  private async safely(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, `${what} falló (la operación ya está confirmada en la prueba)`);
    }
  }
}
