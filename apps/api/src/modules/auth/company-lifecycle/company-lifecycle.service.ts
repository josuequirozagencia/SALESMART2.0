import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { aiWallets, appointmentReminders, automationRuns, contacts, Database, metaEvents, organizationDeletions, organizations, plans, sales, scheduledMessages, sessions, users, type IdentityTx } from '../../../db';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../../errors';
import type { AppLogger } from '../../../logger';
import { MAIL_PROVIDER, type MailProvider } from '../../../mail';
import { PlatformContext, TenantContext } from '../../../tenant';
import { APP_CONFIG, APP_LOGGER } from '../../../tokens';
import { PlatformAuditService } from '../../platform';
import { hashExportToken } from './company-export.store';
import { PasswordConfirmationService } from './password-confirmation.service';
import { deletionRecipients, type DeletionRecipient } from './recipients';
import type { AppConfig } from '../../../config';
import type { DeleteCompanyDto, RecoverCompanyDto } from './company-lifecycle.dto';

/** Días que una empresa eliminada queda recuperable antes del borrado definitivo (ADR-59 #3). Constante del servidor: cambiarla es un cambio de código con ADR. */
export const DELETION_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
/** Un evento a Meta de más de 7 días lo rechaza Meta: al recuperar, los que vencieron durante la pausa se descartan (ADR-59 #6). */
const META_MAX_AGE_MS = 7 * DAY_MS;
/** Motivo que queda escrito en lo que el barrido de recuperación omite. */
const PAUSE_REASON = 'pausa';

export interface DeletionFootprint {
  users: number;
  /** Contactos vigentes (solo empresas cliente). */
  contacts: number;
  sales: number;
  /** Créditos de IA que se perderían. */
  ai_credits: number;
  /** Clientes vigentes de la agencia (solo agencias). */
  clients: number;
}

export interface DeletionPreview {
  id: string;
  name: string;
  kind: 'client' | 'agency';
  state: 'active' | 'suspended' | 'deleted';
  plan: string | null;
  footprint: DeletionFootprint;
  /** Por qué no se puede eliminar ahora (vacío = se puede). */
  blockers: Array<{ code: 'AGENCY_HAS_CLIENTS'; clients: Array<{ id: string; name: string }> }>;
  deletion: { id: string; requested_at: string; purge_after: string; reason: string; requested_by_email: string | null } | null;
  window_days: number;
}

export interface DeleteResult {
  id: string;
  deletion_id: string;
  state: 'deleted';
  purge_after: string;
  notified: number;
}

export interface RecoverResult {
  id: string;
  state: 'active' | 'suspended';
  notified: number;
  /** Lo que venció durante la pausa y se dejó como «omitido» en vez de ejecutarse tarde. */
  skipped: { scheduled_messages: number; appointment_reminders: number; automation_waits: number; meta_events: number };
}

interface Target {
  id: string;
  name: string;
  kind: 'client' | 'agency' | 'platform';
  status: string;
  deletedAt: Date | null;
  planId: string | null;
  timezone: string;
  parentAgencyId: string | null;
  ownerUserId: string | null;
}

/**
 * Eliminar y recuperar una empresa (F3a, ADR-59). Solo el Súper Admin, siempre con su contraseña:
 *  - `delete`: anota la eliminación (`organization_deletions`), pasa la empresa a `deleted` con `deleted_at` y revoca sus sesiones. Con eso se corta el acceso al instante (los controles de sesión,
 *    inicio de sesión, cambio de contexto e invitaciones ya miran ese estado) y las tareas periódicas dejan de recorrerla (`operatingOrg`). No borra NADA: eso es el borrado definitivo (F3c).
 *  - `recover`: dentro de la ventana de 7 días devuelve la empresa a su estado anterior. Antes de reabrirla, deja como «omitido» lo que venció durante la pausa y no debe ejecutarse tarde.
 * La contraseña fallida cuenta en el mismo límite de intentos del inicio de sesión de esa persona (una sesión robada no puede adivinarla sin límite).
 */
@Injectable()
export class CompanyLifecycleService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(PasswordConfirmationService) private readonly passwords: PasswordConfirmationService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Lo que se le muestra al Súper Admin antes de confirmar (y, si ya está eliminada, cuándo se borra). No cambia nada. */
  async preview(orgId: string): Promise<DeletionPreview> {
    const t = await this.load(orgId);
    if (!t || t.kind === 'platform') throw new NotFoundError();
    const footprint = await this.footprint(t);
    const clients = t.kind === 'agency' ? await this.db.withIdentity((tx) => this.agencyClients(tx, t.id)) : [];
    const planName = await this.planName(t.planId);
    const deletion = t.status === 'deleted' ? await this.openDeletion(t.id) : null;
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      state: t.status === 'deleted' ? 'deleted' : t.status === 'active' ? 'active' : 'suspended',
      plan: planName,
      footprint,
      blockers: clients.length > 0 ? [{ code: 'AGENCY_HAS_CLIENTS', clients }] : [],
      deletion,
      window_days: DELETION_WINDOW_DAYS,
    };
  }

  async delete(orgId: string, input: DeleteCompanyDto, now = new Date()): Promise<DeleteResult> {
    const actor = PlatformContext.current().actorUserId;
    await this.passwords.confirm(actor, input.password);
    const t = await this.load(orgId);
    if (!t || t.kind === 'platform' || (t.deletedAt !== null && t.status !== 'deleted')) throw new NotFoundError();
    if (t.status === 'deleted') throw new ConflictError('ALREADY_DELETED', 'La empresa ya está eliminada');
    if (input.confirm_name.trim() !== t.name) throw new ValidationError([{ path: 'confirm_name', code: 'mismatch', message: 'El nombre no coincide con el de la empresa' }]);
    const footprint = await this.footprint(t);
    const planName = await this.planName(t.planId);
    const purgeAfter = new Date(now.getTime() + DELETION_WINDOW_DAYS * DAY_MS);
    // El enlace del dueño para pedir la copia de sus datos (F3b): un token aleatorio de 256 bits; en la base solo queda su huella
    const exportToken = randomBytes(32).toString('base64url');

    const out = await this.db.withIdentity(async (tx) => {
      // Se vuelve a leer CON bloqueo: dos Súper Admin a la vez, o un cambio entre medias, no pueden dejar dos eliminaciones ni borrar una agencia que ganó un cliente
      const [org] = await tx
        .select({ id: organizations.id, kind: organizations.kind, status: organizations.status, deletedAt: organizations.deletedAt, name: organizations.name, parent: organizations.parentAgencyId, owner: organizations.ownerUserId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for('update')
        .limit(1);
      if (!org || org.kind === 'platform' || org.deletedAt !== null) throw new NotFoundError();
      const clients = org.kind === 'agency' ? await this.agencyClients(tx, org.id) : [];
      if (clients.length > 0) {
        throw new AppError(409, 'AGENCY_HAS_CLIENTS', 'La agencia todavía tiene clientes: muévelos o elimínalos primero', clients.map((c) => ({ path: c.id, code: 'client', message: c.name })));
      }
      const [deletion] = await tx
        .insert(organizationDeletions)
        .values({ organizationId: org.id, requestedBy: actor, reason: input.reason, organizationName: org.name, planName, previousStatus: org.status, requestedAt: now, purgeAfter, summary: footprint, exportTokenHash: hashExportToken(exportToken) })
        .returning({ id: organizationDeletions.id });
      await tx.update(organizations).set({ status: 'deleted', deletedAt: now, updatedAt: now }).where(eq(organizations.id, org.id));
      // Las sesiones no reviven al recuperar: cada persona entra de nuevo (ADR-59 #3)
      await tx
        .update(sessions)
        .set({ revokedAt: now, revokeReason: 'company_deleted' })
        .where(and(isNull(sessions.revokedAt), or(eq(sessions.activeOrgId, org.id), eq(sessions.homeOrgId, org.id))));
      const recipients = await this.recipients(tx, org.id, org.kind === 'client' ? org.parent : null, org.owner);
      return { deletionId: deletion!.id, recipients };
    });

    await this.safely('company.deleted', () =>
      this.audit.record({
        action: 'company.deleted',
        entityType: 'organization',
        entityId: orgId,
        targetOrgId: orgId,
        details: { name: t.name, kind: t.kind, plan: planName, previous_status: t.status, reason: input.reason, purge_after: purgeAfter.toISOString(), deletion_id: out.deletionId, ...footprint },
      }),
    );
    const exportLink = this.exportUrl(exportToken);
    let notified = 0;
    for (const r of out.recipients) {
      try {
        await this.mail.sendCompanyDeleted({ to: r.email, organizationName: t.name, purgeAfter, timeZone: t.timezone, audience: r.audience, ...(r.audience === 'owner' && exportLink ? { exportUrl: exportLink } : {}) });
        notified += 1;
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo avisar de la empresa eliminada (la eliminación ya está confirmada)');
      }
    }
    return { id: orgId, deletion_id: out.deletionId, state: 'deleted', purge_after: purgeAfter.toISOString(), notified };
  }

  async recover(orgId: string, input: RecoverCompanyDto, now = new Date()): Promise<RecoverResult> {
    const actor = PlatformContext.current().actorUserId;
    await this.passwords.confirm(actor, input.password);
    const t = await this.load(orgId);
    if (!t || t.kind === 'platform' || t.status !== 'deleted') throw new NotFoundError();
    const open = await this.db.withIdentity(async (tx) => {
      const [d] = await tx
        .select({ id: organizationDeletions.id, state: organizationDeletions.state, purgeAfter: organizationDeletions.purgeAfter, previousStatus: organizationDeletions.previousStatus })
        .from(organizationDeletions)
        .where(and(eq(organizationDeletions.organizationId, orgId), eq(organizationDeletions.state, 'scheduled')))
        .limit(1);
      return d ?? null;
    });
    if (!open) throw new ConflictError('NOT_RECOVERABLE', 'Esta empresa ya no se puede recuperar');
    if (open.purgeAfter.getTime() <= now.getTime()) throw new ConflictError('RECOVERY_WINDOW_CLOSED', 'El plazo para recuperar esta empresa terminó');

    // Antes de reabrirla (mientras las tareas todavía no la recorren): lo que venció durante la pausa y no debe ejecutarse tarde queda como «omitido» (ADR-59 #6)
    const skipped = await this.sweepPause(orgId, actor, now);

    const out = await this.db.withIdentity(async (tx) => {
      const [org] = await tx
        .select({ id: organizations.id, status: organizations.status, parent: organizations.parentAgencyId, kind: organizations.kind, owner: organizations.ownerUserId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for('update')
        .limit(1);
      if (!org || org.status !== 'deleted') throw new NotFoundError();
      // La fila se cierra con una condición: dos recuperaciones a la vez, o una que choca con el borrado definitivo, no pueden ganar las dos
      const closed = await tx
        .update(organizationDeletions)
        .set({ state: 'recovered', recoveredAt: now, recoveredBy: actor })
        .where(and(eq(organizationDeletions.id, open.id), eq(organizationDeletions.state, 'scheduled')))
        .returning({ id: organizationDeletions.id });
      if (closed.length === 0) throw new ConflictError('NOT_RECOVERABLE', 'Esta empresa ya no se puede recuperar');
      const restored = open.previousStatus === 'deleted' ? 'active' : open.previousStatus;
      await tx.update(organizations).set({ status: restored, deletedAt: null, updatedAt: now }).where(eq(organizations.id, org.id));
      const recipients = await this.recipients(tx, org.id, org.kind === 'client' ? org.parent : null, org.owner);
      return { restored, recipients };
    });

    await this.safely('company.recovered', () =>
      this.audit.record({ action: 'company.recovered', entityType: 'organization', entityId: orgId, targetOrgId: orgId, details: { name: t.name, deletion_id: open.id, restored_status: out.restored, skipped } }),
    );
    let notified = 0;
    for (const r of out.recipients) {
      try {
        await this.mail.sendCompanyRecovered({ to: r.email, organizationName: t.name, audience: r.audience });
        notified += 1;
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo avisar de la empresa recuperada (la recuperación ya está confirmada)');
      }
    }
    return { id: orgId, state: out.restored === 'active' ? 'active' : 'suspended', notified, skipped };
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** El enlace con el que el dueño pide la copia de sus datos. El token va en el fragmento (como las invitaciones): no queda en registros del servidor ni en el `Referer`. Sin dirección pública configurada, no hay enlace. */
  private exportUrl(token: string): string | undefined {
    const base = this.cfg.frontend.baseUrl;
    return base ? `${base}/company-export#token=${token}` : undefined;
  }

  private async load(orgId: string): Promise<Target | null> {
    const [row] = await this.db.withIdentity((tx) =>
      tx
        .select({ id: organizations.id, name: organizations.name, kind: organizations.kind, status: organizations.status, deletedAt: organizations.deletedAt, planId: organizations.planId, timezone: organizations.timezone, parentAgencyId: organizations.parentAgencyId, ownerUserId: organizations.ownerUserId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
    );
    return (row as Target | undefined) ?? null;
  }

  private async planName(planId: string | null): Promise<string | null> {
    if (!planId) return null;
    const [p] = await this.db.withIdentity((tx) => tx.select({ name: plans.name }).from(plans).where(eq(plans.id, planId)).limit(1));
    return p?.name ?? null;
  }

  private async agencyClients(tx: IdentityTx, agencyId: string): Promise<Array<{ id: string; name: string }>> {
    return tx
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(and(eq(organizations.parentAgencyId, agencyId), isNull(organizations.deletedAt)))
      .orderBy(asc(organizations.name))
      .limit(50);
  }

  private async openDeletion(orgId: string): Promise<NonNullable<DeletionPreview['deletion']> | null> {
    const d = await this.db.withIdentity(async (tx) => {
      const [row] = await tx
        .select()
        .from(organizationDeletions)
        .where(and(eq(organizationDeletions.organizationId, orgId), inArray(organizationDeletions.state, ['scheduled', 'purging', 'purge_failed'])))
        .limit(1);
      if (!row) return null;
      const [who] = await tx.select({ email: users.email }).from(users).where(eq(users.id, row.requestedBy)).limit(1);
      return { ...row, email: who?.email ?? null };
    });
    return d ? { id: d.id, requested_at: d.requestedAt.toISOString(), purge_after: d.purgeAfter.toISOString(), reason: d.reason, requested_by_email: d.email } : null;
  }

  /** Cuánto hay en la empresa (para la confirmación y la auditoría). Los datos de negocio se leen DENTRO de la empresa, con su RLS, como Súper Admin. */
  private async footprint(t: Target): Promise<DeletionFootprint> {
    // Personas con acceso propio (el personal de una agencia que entra a un cliente no cuenta como usuario del cliente)
    const memberFilter = t.kind === 'agency' ? sql`TRUE` : sql`m.role <> 'agency'`;
    const counts = await this.db.withIdentity(async (tx) => {
      const res = await tx.execute<{ users: number; clients: number }>(sql`
        SELECT (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = ${t.id} AND m.revoked_at IS NULL AND ${memberFilter}) AS users,
               (SELECT count(*)::int FROM organizations c WHERE c.parent_agency_id = ${t.id} AND c.deleted_at IS NULL) AS clients`);
      return res.rows[0];
    });
    const nUsers = Number(counts?.users ?? 0);
    const nClients = Number(counts?.clients ?? 0);
    if (t.kind !== 'client') return { users: nUsers, contacts: 0, sales: 0, ai_credits: 0, clients: nClients };
    const actor = PlatformContext.current().actorUserId;
    const biz = await PlatformContext.detach(() =>
      TenantContext.run({ organizationId: t.id, userId: actor, actingAs: 'super_admin' }, () =>
        this.db.withTenant(async (tx) => {
          const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(contacts).where(isNull(contacts.deletedAt));
          const [s] = await tx.select({ n: sql<number>`count(*)::int` }).from(sales);
          const [w] = await tx.select({ n: aiWallets.balanceCache }).from(aiWallets).limit(1);
          return { contacts: Number(c?.n ?? 0), sales: Number(s?.n ?? 0), credits: Number(w?.n ?? 0) };
        }),
      ),
    );
    return { users: nUsers, contacts: biz.contacts, sales: biz.sales, ai_credits: biz.credits, clients: 0 };
  }

  /** A quién se avisa: el dueño (o, si no consta, el primer administrador vigente) y, si la hay, el personal de la agencia que la administraba. Sin repetir correos. */
  private recipients(tx: IdentityTx, orgId: string, agencyId: string | null, ownerUserId: string | null): Promise<DeletionRecipient[]> {
    return deletionRecipients(tx, orgId, agencyId, ownerUserId);
  }

  /**
   * Lo que venció durante la pausa y ya no debe salir (ADR-59 #6 y DECIDE 9): mensajes programados, recordatorios de citas, esperas de automatizaciones y eventos a Meta de más de 7 días.
   * Corre DENTRO de la empresa (con su RLS) como Súper Admin y deja el motivo «pausa». Lo que aún no venció sigue su curso.
   */
  private async sweepPause(orgId: string, actor: string, now: Date): Promise<RecoverResult['skipped']> {
    return PlatformContext.detach(() =>
      TenantContext.run({ organizationId: orgId, userId: actor, actingAs: 'super_admin' }, () =>
        this.db.withTenant(async (tx) => {
          const msgs = await tx
            .update(scheduledMessages)
            .set({ status: 'cancelled', reason: PAUSE_REASON, resolvedAt: now })
            .where(and(eq(scheduledMessages.status, 'scheduled'), lt(scheduledMessages.sendAt, now)))
            .returning({ id: scheduledMessages.id });
          const reminders = await tx
            .update(appointmentReminders)
            .set({ status: 'skipped', reason: PAUSE_REASON, resolvedAt: now })
            .where(and(eq(appointmentReminders.status, 'scheduled'), lt(appointmentReminders.sendAt, now)))
            .returning({ id: appointmentReminders.id });
          const waits = await tx
            .update(automationRuns)
            .set({ status: 'skipped', reason: PAUSE_REASON, finishedAt: now })
            .where(and(eq(automationRuns.status, 'queued'), sql`${automationRuns.resumeActions} IS NOT NULL`, lt(automationRuns.nextAttemptAt, now)))
            .returning({ id: automationRuns.id });
          const events = await tx
            .update(metaEvents)
            .set({ status: 'expired', lastError: PAUSE_REASON, updatedAt: now })
            .where(and(eq(metaEvents.status, 'pending'), lt(metaEvents.createdAt, new Date(now.getTime() - META_MAX_AGE_MS))))
            .returning({ id: metaEvents.id });
          return { scheduled_messages: msgs.length, appointment_reminders: reminders.length, automation_waits: waits.length, meta_events: events.length };
        }),
      ),
    );
  }

  /** La auditoría de plataforma se escribe tras confirmar: si falla no se deshace la operación, pero queda en el registro de errores. */
  private async safely(action: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, `auditoría ${action} falló (la operación ya está confirmada)`);
    }
  }
}
