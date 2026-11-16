import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from '@sales-smart/shared';
import type { AppConfig } from '../../../config';
import { Database, accessResets, memberHistory, organizationMembers, organizations, passwordResets, sessions, users, type IdentityTx } from '../../../db';
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, TooManyAttemptsError, ValidationError } from '../../../errors';
import type { AppLogger } from '../../../logger';
import { MAIL_PROVIDER, type MailProvider } from '../../../mail';
import { PlatformContext, TenantContext } from '../../../tenant';
import { APP_CONFIG, APP_LOGGER } from '../../../tokens';
import { AuditService } from '../../audit';
import { likeEscape } from '../../organizations';
import { PlatformAuditService } from '../../platform';
import { PasswordConfirmationService } from '../company-lifecycle/password-confirmation.service';
import { DAY_MS, SignupLimiter } from '../signup/signup-limiter';
import { ThrottleService } from '../throttle.service';
import { hashSecret } from '../tokens';
import type { AccessResetDto, AccessResetItem, AccessResetList, AccessResetResult, ListAccessResetsQuery } from './access-reset.dto';
import { actorKindOf, companyVerdict, maskEmail, reasonProblem, type ResetActorKind } from './access-reset.policy';

const NOT_ALLOWED = 'Esta cuenta solo puede restablecerla la plataforma';

interface Target {
  userId: string;
  email: string;
  name: string | null;
}
interface CompanyTarget extends Target {
  orgName: string;
}
interface Applied {
  resetId: string;
  revoked: number;
  token: string;
}

/**
 * Restablecer el acceso de OTRA persona (ADR-71, addendum v16). Quien lo hace (administrador del cliente, agencia con nivel `admin` o Súper Admin) NUNCA ve el enlace ni fija una contraseña: el enlace llega solo al correo de la persona.
 *
 * Orden: motivo → servicio de correo disponible → elegibilidad (404 uniforme / 403) → límites (429) → contraseña propia de quien actúa (se cuenta en el bloqueo del inicio de sesión) → UNA transacción de identidad que
 * bloquea a la persona, vuelve a comprobar la elegibilidad, reemplaza el enlace, deja su contraseña actual inservible, cierra TODAS sus sesiones y escribe el historial → auditoría de la empresa y correos, después de confirmar.
 * Un fallo del correo o de la auditoría no deshace el restablecimiento (las filas de identidad ya quedaron): se registra y la respuesta dice si el correo salió.
 */
@Injectable()
export class AccessResetService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    @Inject(SignupLimiter) private readonly limiter: SignupLimiter,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(PasswordConfirmationService) private readonly confirm: PasswordConfirmationService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PlatformAuditService) private readonly platformAudit: PlatformAuditService,
  ) {}

  // ── Ruta de empresa ──────────────────────────────────────────────────────────

  async resetInCompany(targetId: string, dto: AccessResetDto, ip?: string): Promise<AccessResetResult> {
    const t = TenantContext.current();
    const actor = t.userId;
    if (!actor) throw new NotFoundError();
    const kind = actorKindOf(t.actingAs);
    const reason = this.reasonOf(kind, dto.reason);
    const linkBase = this.assertDeliverable();
    if (targetId === actor) throw new ConflictError('SELF_NOT_ALLOWED', 'No puedes restablecer tu propio acceso: usa «Olvidé mi contraseña» en la pantalla de inicio de sesión');
    const orgId = t.organizationId;
    await this.db.withIdentity((tx) => this.loadCompanyTarget(tx, orgId, targetId, kind, false));
    await this.limits(kind, actor, targetId, kind === 'agency' && t.actingOrgId ? `${t.actingOrgId}|${orgId}` : null);
    await this.confirm.confirm(actor, dto.current_password);

    const label = await this.actorLabel(actor, kind, t.actingOrgId);
    const { target, applied } = await this.db.withIdentity(async (tx) => {
      const target = await this.loadCompanyTarget(tx, orgId, targetId, kind, true);
      const applied = await this.apply(tx, { actor, kind, actorOrgId: t.actingOrgId ?? null, target, orgIds: [orgId], singleOrgId: orgId, reason, ip, via: 'company' });
      return { target, applied };
    });
    try {
      await this.audit.record({ entityType: 'user', entityId: targetId, field: 'access_reset', oldValue: null, newValue: { reason, sessions_revoked: applied.revoked, by: kind }, source: 'manual' });
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo auditar el restablecimiento de acceso en la empresa');
    }
    return this.deliver({ linkBase, target, applied, label, reason, orgs: [{ id: orgId, name: target.orgName }], notifyAdmins: kind !== 'client_admin' });
  }

  /** ¿Esta persona se puede restablecer por la ruta de empresa? Solo sí o no (nunca por qué: no revela otras empresas ni al dueño); lo usa la pantalla para mostrar o no el botón. */
  async canReset(targetId: string): Promise<{ allowed: boolean }> {
    const t = TenantContext.current();
    if (!t.userId || targetId === t.userId) return { allowed: false };
    try {
      await this.db.withIdentity((tx) => this.loadCompanyTarget(tx, t.organizationId, targetId, actorKindOf(t.actingAs), false));
      return { allowed: true };
    } catch (e) {
      if (e instanceof NotFoundError || e instanceof ForbiddenError) return { allowed: false };
      throw e;
    }
  }

  // ── Ruta de plataforma ──────────────────────────────────────────────────────

  async resetFromPlatform(targetId: string, dto: AccessResetDto, ip?: string): Promise<AccessResetResult> {
    const actor = PlatformContext.current().actorUserId;
    const reason = this.reasonOf('super_admin', dto.reason);
    const linkBase = this.assertDeliverable();
    if (targetId === actor) throw new ConflictError('SELF_NOT_ALLOWED', 'No puedes restablecer tu propio acceso: usa «Olvidé mi contraseña» en la pantalla de inicio de sesión');
    await this.db.withIdentity((tx) => this.loadAnyTarget(tx, targetId, false));
    await this.limits('super_admin', actor, targetId, null);
    await this.confirm.confirm(actor, dto.current_password);

    const label = await this.actorLabel(actor, 'super_admin', undefined);
    const { target, orgs, applied } = await this.db.withIdentity(async (tx) => {
      const { target, orgs } = await this.loadAnyTarget(tx, targetId, true);
      const applied = await this.apply(tx, { actor, kind: 'super_admin', actorOrgId: null, target, orgIds: orgs.map((o) => o.id), singleOrgId: orgs.length === 1 ? (orgs[0]?.id ?? null) : null, reason, ip, via: 'platform' });
      return { target, orgs, applied };
    });
    try {
      await this.platformAudit.record({ action: 'user.access_reset', entityType: 'user', entityId: targetId, details: { reason, sessions_revoked: applied.revoked, organizations: orgs.length } });
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo auditar el restablecimiento de acceso en la plataforma');
    }
    // A los administradores de cada EMPRESA a la que pertenece (no a la plataforma ni a una agencia)
    return this.deliver({ linkBase, target, applied, label, reason, orgs: orgs.filter((o) => o.kind === 'client'), notifyAdmins: true });
  }

  // ── Lista para el Súper Admin ───────────────────────────────────────────────

  async list(f: ListAccessResetsQuery): Promise<AccessResetList> {
    const where: SQL[] = [sql`true`];
    if (f.actor_role) where.push(sql`r.actor_role = ${f.actor_role}`);
    if (f.organization_id) where.push(sql`r.organization_id = ${f.organization_id}`);
    if (f.q) {
      const like = `%${likeEscape(f.q)}%`;
      where.push(sql`(au.email ILIKE ${like} ESCAPE '!' OR au.full_name ILIKE ${like} ESCAPE '!' OR r.target_email_masked ILIKE ${like} ESCAPE '!' OR tu.full_name ILIKE ${like} ESCAPE '!' OR o.name ILIKE ${like} ESCAPE '!')`);
    }
    if (f.cursor) {
      const c = decodeCursor(f.cursor);
      where.push(sql`(r.created_at, r.id) < (${c.at}::timestamptz, ${c.id}::uuid)`);
    }
    const rows = await this.db.withIdentity(async (tx) => {
      const res = await tx.execute<ListRow>(sql`
        SELECT r.id, r.actor_role, r.reason, r.sessions_revoked, r.mail_sent, r.created_at, r.target_user_id, r.target_email_masked,
               au.email AS actor_email, au.full_name AS actor_name, tu.full_name AS target_name,
               o.id AS org_id, o.name AS org_name, ao.id AS actor_org_id, ao.name AS actor_org_name
          FROM access_resets r
          JOIN users au ON au.id = r.actor_user_id
          JOIN users tu ON tu.id = r.target_user_id
          LEFT JOIN organizations o ON o.id = r.organization_id
          LEFT JOIN organizations ao ON ao.id = r.actor_org_id
         WHERE ${sql.join(where, sql` AND `)}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ${f.limit + 1}`);
      return res.rows;
    });
    const page = rows.slice(0, f.limit);
    const last = page[page.length - 1];
    const items: AccessResetItem[] = page.map((r) => ({
      id: r.id,
      actor: { email: r.actor_email, name: r.actor_name },
      actor_role: r.actor_role,
      actor_org: r.actor_org_id && r.actor_org_name ? { id: r.actor_org_id, name: r.actor_org_name } : null,
      organization: r.org_id && r.org_name ? { id: r.org_id, name: r.org_name } : null,
      target: { id: r.target_user_id, email_hint: r.target_email_masked, name: r.target_name },
      reason: r.reason,
      sessions_revoked: r.sessions_revoked,
      mail_sent: r.mail_sent,
      created_at: new Date(r.created_at).toISOString(),
    }));
    return { items, next_cursor: rows.length > f.limit && last ? encodeCursor(new Date(last.created_at), last.id) : null };
  }

  // ── Piezas ───────────────────────────────────────────────────────────────────

  private reasonOf(kind: ResetActorKind, raw: string | undefined): string | null {
    const r = reasonProblem(kind, raw);
    if (r.problem) throw new ValidationError([{ path: 'reason', code: 'invalid', message: r.problem }]);
    return r.reason;
  }

  /** Sin proveedor de correo o sin dirección pública NO se restablece: no se puede dejar a alguien sin acceso sin poder avisarle. */
  private assertDeliverable(): string {
    const linkBase = this.cfg.frontend.resetLinkBase;
    if (!this.mail.available || linkBase === undefined) throw new ServiceUnavailableError('ACCESS_RESET_UNAVAILABLE', 'No se puede restablecer el acceso: el envío de correos no está disponible');
    return linkBase;
  }

  private async limits(kind: ResetActorKind, actor: string, target: string, agencyOrg: string | null): Promise<void> {
    const c = this.cfg.accessReset;
    const perActor = kind === 'agency' ? c.agencyMaxPerHour : kind === 'super_admin' ? c.superAdminMaxPerHour : c.adminMaxPerHour;
    const checks = [await this.limiter.hit(this.limiter.keyFor('a', actor), perActor), await this.limiter.hit(this.limiter.keyFor('t', target), c.targetMaxPerHour)];
    if (agencyOrg) checks.push(await this.limiter.hit(this.limiter.keyFor('o', agencyOrg), c.agencyOrgMaxPerDay, new Date(), DAY_MS));
    const blocked = checks.find((x) => !x.allowed);
    if (blocked) throw new TooManyAttemptsError(blocked.retryAfterSeconds);
  }

  /** La persona de la ruta, con las reglas de la política. 404 si no es de esta empresa o no se puede restablecer (pendiente, desactivada, borrada); 403 si es de las que solo restablece la plataforma. */
  private async loadCompanyTarget(tx: IdentityTx, orgId: string, userId: string, kind: ResetActorKind, lock: boolean): Promise<CompanyTarget> {
    const q = tx
      .select({ userId: users.id, email: users.email, name: users.fullName, status: users.status, verified: users.emailVerifiedAt, role: organizationMembers.role, owner: organizations.ownerUserId, orgName: organizations.name })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, userId), isNull(organizationMembers.revokedAt), isNull(users.deletedAt)))
      .limit(1);
    const [row] = await (lock ? q.for('update', { of: users }) : q);
    if (!row || row.status !== 'active' || row.verified === null) throw new NotFoundError();
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(organizationMembers.userId, userId), isNull(organizationMembers.revokedAt), isNull(organizations.deletedAt)));
    const v = companyVerdict(kind, { roleHere: row.role, activeMemberships: count?.n ?? 0, isOwner: row.owner === userId }, this.cfg.accessReset.agencyCanResetOwner);
    if (!v.ok) {
      if (v.reason === 'not_member') throw new NotFoundError();
      throw new ForbiddenError('RESET_NOT_ALLOWED', NOT_ALLOWED);
    }
    return { userId: row.userId, email: row.email, name: row.name, orgName: row.orgName };
  }

  /** Para la plataforma: cualquier persona con cuenta utilizable y sus membresías vigentes. */
  private async loadAnyTarget(tx: IdentityTx, userId: string, lock: boolean): Promise<{ target: Target; orgs: Array<{ id: string; name: string; kind: string }> }> {
    const q = tx.select({ userId: users.id, email: users.email, name: users.fullName, status: users.status, verified: users.emailVerifiedAt }).from(users).where(and(eq(users.id, userId), isNull(users.deletedAt))).limit(1);
    const [row] = await (lock ? q.for('update') : q);
    if (!row || row.status !== 'active' || row.verified === null) throw new NotFoundError();
    const orgs = await tx
      .selectDistinct({ id: organizations.id, name: organizations.name, kind: organizations.kind })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(organizationMembers.userId, userId), isNull(organizationMembers.revokedAt), isNull(organizations.deletedAt)));
    return { target: { userId: row.userId, email: row.email, name: row.name }, orgs };
  }

  private async actorLabel(actor: string, kind: ResetActorKind, actingOrgId: string | undefined): Promise<string> {
    if (kind === 'super_admin') return 'El equipo de la plataforma';
    if (kind === 'agency') {
      const [o] = actingOrgId ? await this.db.withIdentity((tx) => tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, actingOrgId)).limit(1)) : [];
      return o?.name ? `La agencia ${o.name}` : 'Una agencia';
    }
    const [u] = await this.db.withIdentity((tx) => tx.select({ name: users.fullName }).from(users).where(eq(users.id, actor)).limit(1));
    return u?.name ? `El administrador ${u.name}` : 'Un administrador de tu empresa';
  }

  /** La transacción: enlace nuevo (reemplaza al pendiente), contraseña actual inservible, sesiones cerradas, historial y registro. Todo o nada. */
  private async apply(
    tx: IdentityTx,
    p: { actor: string; kind: ResetActorKind; actorOrgId: string | null; target: Target; orgIds: string[]; singleOrgId: string | null; reason: string | null; ip: string | undefined; via: 'company' | 'platform' },
  ): Promise<Applied> {
    const now = new Date();
    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    const values = { id, tokenHash: hashSecret(secret), expiresAt: new Date(now.getTime() + this.cfg.accessReset.tokenTtlMs), consumedAt: null, lastSentAt: now, origin: 'admin', requestedBy: p.actor };
    // Al reemplazar la fila el enlace anterior (también el de «olvidé mi contraseña») deja de existir
    await tx
      .insert(passwordResets)
      .values({ userId: p.target.userId, ...values })
      .onConflictDoUpdate({ target: passwordResets.userId, set: { ...values, sentCount: sql`${passwordResets.sentCount} + 1` } });
    await tx.update(users).set({ accessResetPendingAt: now, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now }).where(eq(users.id, p.target.userId));
    const closed = await tx.update(sessions).set({ revokedAt: now, revokeReason: 'access_reset' }).where(and(eq(sessions.userId, p.target.userId), isNull(sessions.revokedAt))).returning({ id: sessions.id });
    const revoked = closed.length;
    for (const orgId of p.orgIds) {
      await tx.insert(memberHistory).values({ organizationId: orgId, userId: p.target.userId, changedBy: p.actor, kind: 'access_reset', before: null, after: { reason: p.reason, by: p.kind, via: p.via, sessions_revoked: revoked } });
    }
    const [row] = await tx
      .insert(accessResets)
      .values({
        actorUserId: p.actor,
        actorRole: p.kind,
        actorOrgId: p.actorOrgId,
        organizationId: p.singleOrgId,
        targetUserId: p.target.userId,
        targetEmailMasked: maskEmail(p.target.email),
        reason: p.reason,
        sessionsRevoked: revoked,
        ipHash: p.ip ? this.throttle.keyFor('i', p.ip).slice(2) : null,
      })
      .returning({ id: accessResets.id });
    return { resetId: row?.id ?? id, revoked, token: `${id}.${secret}` };
  }

  /** Correos DESPUÉS de confirmar. El enlace solo va a la persona; los administradores reciben un aviso sin enlace. */
  private async deliver(p: { linkBase: string; target: Target; applied: Applied; label: string; reason: string | null; orgs: Array<{ id: string; name: string }>; notifyAdmins: boolean }): Promise<AccessResetResult> {
    let mailSent = false;
    try {
      await this.mail.sendAccessReset({
        to: p.target.email,
        resetUrl: `${p.linkBase}#token=${p.applied.token}`,
        expiresInMinutes: Math.round(this.cfg.accessReset.tokenTtlMs / 60_000),
        actorLabel: p.label,
        organizationName: p.orgs.length === 1 ? (p.orgs[0]?.name ?? null) : null,
        reason: p.reason,
      });
      mailSent = true;
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'MailProvider falló al enviar el restablecimiento de acceso');
    }
    if (mailSent) {
      try {
        await this.db.withIdentity((tx) => tx.update(accessResets).set({ mailSent: true }).where(eq(accessResets.id, p.applied.resetId)));
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'no se pudo anotar que el correo del restablecimiento salió');
      }
    }
    const notified = p.notifyAdmins && p.reason ? await this.notifyAdmins(p.orgs, p.target, p.label, p.reason) : 0;
    return { user_id: p.target.userId, sessions_revoked: p.applied.revoked, email_hint: maskEmail(p.target.email), mail_sent: mailSent, notified };
  }

  /** A los administradores del cliente de cada empresa (sin repetir correos y sin la propia persona afectada, que ya recibió el suyo). */
  private async notifyAdmins(orgs: Array<{ id: string; name: string }>, target: Target, label: string, reason: string): Promise<number> {
    if (orgs.length === 0) return 0;
    const rows = await this.db.withIdentity((tx) =>
      tx
        .selectDistinct({ email: users.email, orgId: organizationMembers.organizationId })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(inArray(organizationMembers.organizationId, orgs.map((o) => o.id)), eq(organizationMembers.role, 'client_admin'), isNull(organizationMembers.revokedAt), eq(users.status, 'active'), isNull(users.deletedAt), sql`${users.id} <> ${target.userId}`)),
    );
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const seen = new Set<string>();
    let sent = 0;
    for (const r of rows) {
      if (seen.has(r.email)) continue;
      seen.add(r.email);
      try {
        await this.mail.sendAccessResetNotice({ to: r.email, actorLabel: label, targetName: target.name ?? target.email, organizationName: orgName.get(r.orgId) ?? '', reason });
        sent += 1;
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'MailProvider falló al avisar del restablecimiento de acceso');
      }
    }
    return sent;
  }
}

type ListRow = {
  id: string;
  actor_role: 'client_admin' | 'agency' | 'super_admin';
  reason: string | null;
  sessions_revoked: number;
  mail_sent: boolean;
  created_at: Date | string;
  target_user_id: string;
  target_email_masked: string;
  actor_email: string;
  actor_name: string | null;
  target_name: string | null;
  org_id: string | null;
  org_name: string | null;
  actor_org_id: string | null;
  actor_org_name: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encodeCursor = (at: Date, id: string): string => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
function decodeCursor(raw: string): { at: string; id: string } {
  const bad = (): never => {
    throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor inválido' }]);
  };
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !UUID_RE.test(id)) return bad();
  return { at, id };
}
