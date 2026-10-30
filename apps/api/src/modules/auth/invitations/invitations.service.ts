import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@sales-smart/shared';
import type { AppConfig } from '../../../config';
import { Database, invitations, memberHistory, memberPermissions, organizationMembers, organizationOwnershipHistory, organizations, plans, trials, users, type IdentityTx } from '../../../db';
import { AppError, ConflictError, type ErrorDetail, ForbiddenError, InvalidInvitationError, InvitationExpiredError, NotFoundError, ServiceUnavailableError, TooManyAttemptsError, ValidationError } from '../../../errors';
import type { AppLogger } from '../../../logger';
import type { PasswordHasher } from '../../../security';
import { PlatformContext, TenantContext } from '../../../tenant';
import { APP_CONFIG, APP_LOGGER } from '../../../tokens';
import { AuditService } from '../../audit';
import { AgencyAccessService, TrialsService } from '../../organizations';
import { PlatformAuditService } from '../../platform';
import { isGrantable, isOverrideRole, isPermissionKey, validateOverrides, type PermissionKey } from '../../../rbac';
import { memberJoined } from './member-joined';
import { PASSWORD_HASHER } from '../auth.tokens';
import { MAIL_PROVIDER, type MailProvider } from '../../../mail';
import { SignupLimiter } from '../signup/signup-limiter';
import { ThrottleService } from '../throttle.service';
import { hashSecret, parseToken, sameHash } from '../tokens';
import type { CreateAgencyDto, CreateCompanyDto, RegisterClientDto } from './invitations.dto';

export type InvitationDelivery = 'sent' | 'failed' | 'unavailable';

export interface InvitationIssued {
  email: string;
  expires_at: string;
  delivery: InvitationDelivery;
  /** SOLO cuando el correo no salió (`delivery` ≠ `sent`): el Súper Admin lo entrega por otro medio. Nunca con `sent`. */
  invite_url?: string;
}

export interface CompanyCreated {
  company: { id: string; name: string; kind: 'client' | 'agency'; state: 'invited'; plan: { id: string; name: string } | null; timezone: string; country: string };
  invitation: InvitationIssued;
}

export interface InvitationPreview {
  organization_name: string;
  email: string;
  role: string;
  expires_at: string;
  /** Si el correo ya tiene cuenta: la web pide su contraseña actual en lugar de crear una. */
  account_exists: boolean;
}

/** Lo que el administrador eligió al invitar a alguien a su equipo y se aplica AL ACEPTAR (M10.3): ajustes de permisos y departamentos. `cancelled` marca una invitación cancelada. */
export interface MemberSetup {
  grant: string[];
  deny: string[];
  queue_ids: string[];
  cancelled?: boolean;
}
const setupOf = (raw: unknown): MemberSetup | null => {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { grant: list(o['grant']), deny: list(o['deny']), queue_ids: list(o['queue_ids']), ...(o['cancelled'] === true ? { cancelled: true } : {}) };
};

export interface MemberInvitationView {
  id: string;
  email: string;
  role: 'client_admin' | 'advisor';
  expires_at: string;
  expired: boolean;
  sent_count: number;
  last_sent_at: string;
  setup: { grant: string[]; deny: string[]; queue_ids: string[] };
}

/** Quién crea o reenvía: el Súper Admin (plataforma) o una agencia que registra a un cliente de su cartera (ADR-41). */
type Origin = { by: 'platform'; actor: string } | { by: 'agency'; actor: string; agencyId: string };

const platformOrigin = (): Origin => ({ by: 'platform', actor: PlatformContext.current().actorUserId });
/** El origen sale SIEMPRE del contexto verificado (nunca de la petición): la agencia es la organización del principal. */
const agencyOrigin = (): Origin => {
  const c = TenantContext.current();
  if (!c.userId) throw new ForbiddenError();
  return { by: 'agency', actor: c.userId, agencyId: c.organizationId };
};

type Loaded = {
  id: string;
  organizationId: string;
  orgName: string;
  orgPlanId: string | null;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: Date;
  setup: MemberSetup | null;
};

/**
 * Alta de empresa con invitación al dueño y aceptación del enlace (M2.3, ADR-39, flujo F01).
 *  - Todo el acceso a datos pasa por `withIdentity` (invitaciones, organizaciones, usuarios, membresías, pruebas son tablas de identidad).
 *  - Token opaco `<id>.<secreto>` de un solo uso con caducidad; en BD solo su SHA-256. Un reenvío reemplaza la fila (id nuevo).
 *  - La aceptación bloquea la fila de la invitación y consume el token de forma condicional: dos aceptaciones simultáneas, gana una.
 *  - El correo se envía DESPUÉS de confirmar la transacción. Si no sale, la empresa y la invitación ya existen y el Súper Admin recibe el
 *    enlace para entregarlo por otro medio (ADR-39 #5). El token jamás se registra ni se audita.
 */
@Injectable()
export class InvitationsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    @Inject(SignupLimiter) private readonly limiter: SignupLimiter,
    @Inject(ThrottleService) private readonly throttle: ThrottleService,
    @Inject(TrialsService) private readonly trials: TrialsService,
    @Inject(AgencyAccessService) private readonly agencyAccess: AgencyAccessService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(AuditService) private readonly clientAudit: AuditService,
  ) {}

  // ── Súper Admin ───────────────────────────────────────────────────────────

  /** Crea la empresa (cliente) y la invitación del dueño en una transacción; luego intenta enviar el correo. */
  createCompany(input: CreateCompanyDto): Promise<CompanyCreated> {
    return this.create('client', input, platformOrigin());
  }

  /**
   * «Registrar cliente» (F02, ADR-41): la AGENCIA crea la empresa de un cliente en su cartera (`parent_agency_id` y `created_by_agency_id` = la agencia del
   * contexto) e invita a su dueño. Sin plan: el cliente paga el suyo y su prueba de 7 días empieza al aceptar. La agencia y su personal reciben acceso al
   * cliente en la misma transacción (con el nivel por defecto) y el alta queda en el historial de la cartera.
   */
  registerClient(input: RegisterClientDto): Promise<CompanyCreated> {
    return this.create('client', { ...input, plan_id: null }, agencyOrigin());
  }

  /** Crea una AGENCIA y la invitación de su dueño (ADR-40): sin plan ni prueba; la invitación lleva el rol `agency`. */
  createAgency(input: CreateAgencyDto): Promise<CompanyCreated> {
    return this.create('agency', { ...input, plan_id: null }, platformOrigin());
  }

  private async create(kind: 'client' | 'agency', input: CreateCompanyDto, origin: Origin): Promise<CompanyCreated> {
    const linkBase = this.linkBase();
    const actor = origin.actor;
    const planId = input.plan_id ?? null;
    const out = await this.db.withIdentity(async (tx) => {
      if (origin.by === 'agency') {
        // Defensa en profundidad: quien registra debe ser una AGENCIA activa (el permiso ya lo restringe al rol `agency` en su organización)
        const [ag] = await tx.select({ kind: organizations.kind, status: organizations.status, deletedAt: organizations.deletedAt }).from(organizations).where(eq(organizations.id, origin.agencyId)).limit(1);
        if (!ag || ag.kind !== 'agency' || ag.status !== 'active' || ag.deletedAt !== null) throw new ForbiddenError();
      }
      let plan: { id: string; name: string } | null = null;
      if (planId) {
        const [p] = await tx.select({ id: plans.id, name: plans.name, archivedAt: plans.archivedAt }).from(plans).where(eq(plans.id, planId)).for('share').limit(1);
        if (!p) throw new AppError(404, 'PLAN_NOT_FOUND', 'El plan no existe');
        if (p.archivedAt) throw new ConflictError('PLAN_ARCHIVED', 'El plan está archivado: restáuralo o elige otro');
        plan = { id: p.id, name: p.name };
      }
      const [org] = await tx
        .insert(organizations)
        .values({ kind, name: input.name, timezone: input.timezone, country: input.country, planId, ...(origin.by === 'agency' ? { parentAgencyId: origin.agencyId, createdByAgencyId: origin.agencyId } : {}) })
        .returning({ id: organizations.id });
      const issued = await this.issue(tx, { organizationId: org!.id, email: input.owner_email, role: kind === 'agency' ? 'agency' : 'client_admin', invitedBy: actor });
      if (origin.by === 'agency') {
        await tx.insert(organizationOwnershipHistory).values({ organizationId: org!.id, fromAgencyId: null, toAgencyId: origin.agencyId, reason: 'Registrado por la agencia', notifyClient: false, changedBy: actor });
        await this.agencyAccess.reconcileClient(tx, org!.id, actor);
      }
      return { orgId: org!.id, plan, issued };
    });
    const invitation = await this.deliver(linkBase, input.owner_email, input.name, out.issued, kind);
    const prefix = kind === 'agency' ? 'agency' : 'company';
    if (origin.by === 'agency') {
      // Auditoría de la AGENCIA (su contexto de organización): quién registró a qué cliente
      await this.safely('client.registered', () =>
        this.clientAudit.record({ entityType: 'organization', entityId: out.orgId, newValue: { name: input.name, country: input.country, timezone: input.timezone, owner_email: input.owner_email, delivery: invitation.delivery } }),
      );
    } else {
      await this.safely(`${prefix}.created`, () =>
        this.audit.record({
          action: `${prefix}.created`,
          entityType: 'organization',
          entityId: out.orgId,
          targetOrgId: out.orgId,
          details: { name: input.name, country: input.country, timezone: input.timezone, plan_id: planId, owner_email: input.owner_email, delivery: invitation.delivery },
        }),
      );
    }
    return { company: { id: out.orgId, name: input.name, kind, state: 'invited', plan: out.plan, timezone: input.timezone, country: input.country }, invitation };
  }

  /** Reenvía la invitación pendiente de una empresa: reemplaza el token (el enlace anterior deja de valer). */
  resend(orgId: string): Promise<InvitationIssued> {
    return this.resendFor(orgId, platformOrigin());
  }

  /** Igual, pero a un cliente de la CARTERA de la agencia del contexto. Un cliente ajeno es un 404 como si no existiera. */
  resendForAgency(clientId: string): Promise<InvitationIssued> {
    return this.resendFor(clientId, agencyOrigin());
  }

  private async resendFor(orgId: string, origin: Origin): Promise<InvitationIssued> {
    const linkBase = this.linkBase();
    const actor = origin.actor;
    const out = await this.db.withIdentity(async (tx) => {
      if (origin.by === 'agency') {
        const [own] = await tx.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.id, orgId), eq(organizations.parentAgencyId, origin.agencyId), eq(organizations.kind, 'client'))).limit(1);
        if (!own) throw new NotFoundError();
      }
      const [row] = await tx
        .select({ id: invitations.id, email: invitations.email, role: invitations.role, consumedAt: invitations.consumedAt, lastSentAt: invitations.lastSentAt, orgName: organizations.name, orgKind: organizations.kind, orgDeleted: organizations.deletedAt })
        .from(invitations)
        .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
        .where(and(eq(invitations.organizationId, orgId), isNull(invitations.consumedAt), isNull(invitations.setup)))
        .for('update', { of: invitations })
        .limit(1);
      // Solo la invitación del dueño (sin `setup`): las de equipo se reenvían desde «Usuarios»
      if (!row || row.orgDeleted) {
        // Distingue «no existe» de «ya aceptada» sin filtrar nada más: el Súper Admin ya ve todas las empresas
        const [any] = await tx.select({ id: invitations.id }).from(invitations).where(and(eq(invitations.organizationId, orgId), isNull(invitations.setup))).limit(1);
        if (any) throw new ConflictError('INVITATION_ALREADY_ACCEPTED', 'La invitación ya fue aceptada');
        throw new NotFoundError();
      }
      const wait = this.cfg.invite.resendCooldownMs - (Date.now() - row.lastSentAt.getTime());
      if (wait > 0) throw new TooManyAttemptsError(Math.ceil(wait / 1000));
      const issued = await this.issue(tx, { organizationId: orgId, email: row.email, role: row.role, invitedBy: actor });
      return { orgName: row.orgName, orgKind: row.orgKind === 'agency' ? ('agency' as const) : ('client' as const), email: row.email, issued };
    });
    const invitation = await this.deliver(linkBase, out.email, out.orgName, out.issued, out.orgKind);
    const prefix = out.orgKind === 'agency' ? 'agency' : 'company';
    if (origin.by === 'agency') {
      await this.safely('client.invitation_resent', () =>
        this.clientAudit.record({ entityType: 'organization', entityId: orgId, field: 'invitation', newValue: { event: 'resent', owner_email: out.email, delivery: invitation.delivery } }),
      );
    } else {
      await this.safely(`${prefix}.invitation_resent`, () =>
        this.audit.record({ action: `${prefix}.invitation_resent`, entityType: 'organization', entityId: orgId, targetOrgId: orgId, details: { owner_email: out.email, delivery: invitation.delivery } }),
      );
    }
    return invitation;
  }

  // ── Público (el dueño invitado) ───────────────────────────────────────────

  async preview(input: { token: string; ip?: string }): Promise<InvitationPreview> {
    await this.guardIp(input.ip);
    const parsed = parseToken(input.token);
    if (!parsed) throw new InvalidInvitationError();
    const found = await this.db.withIdentity(async (tx) => {
      const row = await this.loadValid(tx, parsed.sessionId, parsed.hash, false);
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, row.email)).limit(1);
      return { row, accountExists: !!u };
    });
    return { organization_name: found.row.orgName, email: found.row.email, role: found.row.role, expires_at: found.row.expiresAt.toISOString(), account_exists: found.accountExists };
  }

  async accept(input: { token: string; password: string; fullName?: string; phone?: string; ip?: string }): Promise<{ status: 'accepted'; email: string; account_created: boolean }> {
    await this.guardIp(input.ip);
    const parsed = parseToken(input.token);
    if (!parsed) throw new InvalidInvitationError();
    const min = this.cfg.signup.passwordMinLength;

    // Lectura previa SIN bloqueo: decide si hay que crear la cuenta (y calcular su hash fuera de la transacción) o verificar la existente
    const pre = await this.db.withIdentity(async (tx) => {
      const row = await this.loadValid(tx, parsed.sessionId, parsed.hash, false);
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, row.email)).limit(1);
      return { row, accountExists: !!u };
    });
    const eKey = this.throttle.keyFor('e', pre.row.email);
    let newHash: string | null = null;
    if (pre.accountExists) {
      const wait = await this.throttle.waitSeconds([eKey]);
      if (wait > 0) throw new TooManyAttemptsError(wait);
    } else {
      const issues: ErrorDetail[] = [];
      if (input.password.length < min) issues.push({ path: 'password', code: 'too_short', message: `Debe tener al menos ${min} caracteres` });
      if (!input.fullName) issues.push({ path: 'full_name', code: 'required', message: 'Escribe tu nombre completo' });
      if (!input.phone) issues.push({ path: 'phone', code: 'required', message: 'Escribe tu WhatsApp' });
      if (issues.length > 0) throw new ValidationError(issues);
      newHash = await this.hasher.hash(input.password);
    }

    type Outcome = { kind: 'ok'; created: boolean; email: string; orgId: string; userId: string; setup: MemberSetup | null } | { kind: 'bad_password' } | { kind: 'conflict' };
    const out = await this.db.withIdentity(async (tx): Promise<Outcome> => {
      const inv = await this.loadValid(tx, parsed.sessionId, parsed.hash, true);
      const now = new Date();
      const [existing] = await tx
        .select({ id: users.id, hash: users.passwordHash, status: users.status, verifiedAt: users.emailVerifiedAt, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.email, inv.email))
        .for('update')
        .limit(1);
      let userId: string;
      let created = false;
      if (existing) {
        if (existing.status !== 'active' || existing.verifiedAt === null || existing.deletedAt !== null) throw new InvalidInvitationError();
        if (!(await this.hasher.verify(existing.hash, input.password))) return { kind: 'bad_password' };
        userId = existing.id;
      } else {
        if (newHash === null) return { kind: 'conflict' }; // la cuenta no existía en la lectura previa y ahora tampoco: reintento limpio
        const [u] = await tx
          .insert(users)
          .values({ email: inv.email, passwordHash: newHash, status: 'active', emailVerifiedAt: now, fullName: input.fullName ?? null, phone: input.phone ?? null })
          .onConflictDoNothing({ target: users.email })
          .returning({ id: users.id });
        if (!u) return { kind: 'conflict' }; // otro registro del mismo correo ganó la carrera
        userId = u.id;
        created = true;
      }
      const [member] = await tx
        .select({ id: organizationMembers.id })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.organizationId, inv.organizationId), isNull(organizationMembers.revokedAt)))
        .limit(1);
      let membershipId = member?.id;
      if (!member) {
        const [m] = await tx.insert(organizationMembers).values({ userId, organizationId: inv.organizationId, role: inv.role, grantedBy: inv.invitedBy }).returning({ id: organizationMembers.id });
        membershipId = m!.id;
        // Lo que el administrador eligió al invitar (M10.3): los ajustes se aplican dentro del techo del rol; lo que no cabe se descarta (un dato indebido no concede nada)
        const setup = inv.setup;
        if (setup && isOverrideRole(inv.role)) {
          const role = inv.role;
          const rows = [
            ...setup.grant.filter((k): k is PermissionKey => isPermissionKey(k) && isGrantable(role, k)).map((k) => ({ membershipId: membershipId!, permissionKey: k, effect: 'grant', grantedBy: inv.invitedBy })),
            ...setup.deny.filter((k): k is PermissionKey => isPermissionKey(k) && !(k === 'users.manage')).map((k) => ({ membershipId: membershipId!, permissionKey: k, effect: 'deny', grantedBy: inv.invitedBy })),
          ];
          if (rows.length > 0) await tx.insert(memberPermissions).values(rows).onConflictDoNothing();
        }
        if (inv.role === 'client_admin' || inv.role === 'advisor') await tx.insert(memberHistory).values({ organizationId: inv.organizationId, userId, changedBy: userId, kind: 'invited', before: null, after: { event: 'accepted', role: inv.role } });
      }
      // Quien entra a una AGENCIA recibe acceso a los clientes que ya estén en su cartera (invariante de ADR-40)
      if (inv.role === 'agency') await this.agencyAccess.reconcileAgency(tx, inv.organizationId, inv.invitedBy, now);
      // Sin plan, la prueba de 7 días empieza AL ACEPTAR (ADR-23 #2 / ADR-39): el dueño ya demostró el control del correo
      if (inv.role === 'client_admin' && inv.orgPlanId === null) {
        const [t] = await tx.select({ id: trials.id }).from(trials).where(eq(trials.organizationId, inv.organizationId)).limit(1);
        if (!t) await this.trials.startFor(tx, { organizationId: inv.organizationId, ownerUserId: userId }, now);
      }
      // Consumo condicional: aunque fallara el bloqueo de fila, solo una transacción puede usar el token
      const used = await tx
        .update(invitations)
        .set({ consumedAt: now, acceptedUserId: userId })
        .where(and(eq(invitations.id, inv.id), isNull(invitations.consumedAt)))
        .returning({ id: invitations.id });
      if (used.length === 0) throw new InvalidInvitationError();
      return { kind: 'ok', created, email: inv.email, orgId: inv.organizationId, userId, setup: inv.setup };
    });

    if (out.kind === 'bad_password') {
      await this.throttle.recordFailure(eKey); // quien tiene el enlace no puede adivinar la contraseña de la cuenta sin límite
      throw new AppError(400, 'INVALID_PASSWORD', 'La contraseña no es correcta');
    }
    if (out.kind === 'conflict') throw new ConflictError('CONFLICT', 'La cuenta cambió mientras se procesaba la solicitud. Vuelve a intentarlo');
    if (!out.created) await this.throttle.reset(eKey);
    // Los departamentos elegidos al invitar son de negocio: se aplican ya confirmada la aceptación (si falla, la persona entra igual y el administrador los pone a mano)
    if (out.setup && out.setup.queue_ids.length > 0) {
      await memberJoined.emit({ organizationId: out.orgId, userId: out.userId, setup: { grant: out.setup.grant, deny: out.setup.deny, queue_ids: out.setup.queue_ids } }, (err) => this.log.error({ err: err instanceof Error ? err.message : 'desconocido' }, 'no se pudieron aplicar los departamentos de la invitación'));
    }
    return { status: 'accepted', email: out.email, account_created: out.created };
  }

  // ── Equipo de una empresa (M10.3, ADR-56 B3): lo hace un administrador con `users.manage` ───────────────────────────────

  /** Invitaciones de equipo pendientes de la empresa del contexto (no aceptadas ni canceladas). */
  async listMemberInvitations(): Promise<MemberInvitationView[]> {
    const org = TenantContext.current().organizationId;
    const rows = await this.db.withIdentity((tx) =>
      tx.select().from(invitations).where(and(eq(invitations.organizationId, org), isNull(invitations.consumedAt))).orderBy(sql`${invitations.createdAt} DESC`),
    );
    const now = Date.now();
    return rows
      .filter((r) => (r.role === 'client_admin' || r.role === 'advisor') && !setupOf(r.setup)?.cancelled)
      .map((r) => {
        const setup = setupOf(r.setup) ?? { grant: [], deny: [], queue_ids: [] };
        return { id: r.id, email: r.email, role: r.role as 'client_admin' | 'advisor', expires_at: r.expiresAt.toISOString(), expired: r.expiresAt.getTime() <= now, sent_count: r.sentCount, last_sent_at: r.lastSentAt.toISOString(), setup: { grant: setup.grant, deny: setup.deny, queue_ids: setup.queue_ids } };
      });
  }

  /**
   * Invita a una persona al equipo de la empresa del contexto con el rol y los ajustes elegidos (que quien invita debe poder conceder: `holder` = sus permisos). Mismo token,
   * caducidad y entrega que ADR-39. Un correo que ya es miembro ACTIVO de la empresa es un 409; uno desactivado o quitado se reactiva al aceptar; el de un Súper Admin
   * se rechaza (una cuenta de plataforma no es miembro de un cliente). La cuenta existente confirma con su contraseña al aceptar y no se duplica.
   */
  async inviteMember(input: { email: string; role: 'client_admin' | 'advisor'; setup: { grant: PermissionKey[]; deny: PermissionKey[]; queue_ids: string[] } }, holder: ReadonlySet<PermissionKey>): Promise<InvitationIssued & { id: string }> {
    const c = TenantContext.current();
    if (!c.userId) throw new ForbiddenError();
    const orgId = c.organizationId;
    const actor = c.userId;
    const linkBase = this.linkBase();
    const issues = validateOverrides(input.role, { grant: input.setup.grant, deny: input.setup.deny }, holder);
    if (issues.length > 0) throw new ValidationError(issues.map((i) => ({ path: `permissions.${i.key}`, code: i.code.toLowerCase(), message: i.message })));
    const out = await this.db.withIdentity(async (tx) => {
      const [org] = await tx.select({ name: organizations.name, kind: organizations.kind, status: organizations.status, deletedAt: organizations.deletedAt }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      if (!org || org.kind !== 'client' || org.status !== 'active' || org.deletedAt) throw new NotFoundError();
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
      if (u) {
        const [sa] = await tx.select({ id: organizationMembers.id }).from(organizationMembers).where(and(eq(organizationMembers.userId, u.id), eq(organizationMembers.role, 'super_admin'), isNull(organizationMembers.revokedAt))).limit(1);
        if (sa) throw new AppError(400, 'INVITE_NOT_ALLOWED', 'No se puede invitar a ese correo');
        const [member] = await tx.select({ id: organizationMembers.id }).from(organizationMembers).where(and(eq(organizationMembers.userId, u.id), eq(organizationMembers.organizationId, orgId), isNull(organizationMembers.revokedAt))).limit(1);
        if (member) throw new ConflictError('MEMBER_EXISTS', 'Esa persona ya forma parte de tu equipo');
      }
      const issued = await this.issue(tx, { organizationId: orgId, email: input.email, role: input.role, invitedBy: actor, setup: { grant: input.setup.grant, deny: input.setup.deny, queue_ids: input.setup.queue_ids } });
      await tx.insert(memberHistory).values({ organizationId: orgId, userId: u?.id ?? null, changedBy: actor, kind: 'invited', before: null, after: { event: 'sent', email: input.email, role: input.role } });
      return { orgName: org.name, issued };
    });
    const invitation = await this.deliver(linkBase, input.email, out.orgName, out.issued, 'client');
    await this.safely('team.invited', () => this.clientAudit.record({ entityType: 'user', entityId: out.issued.id, field: 'invitation', newValue: { event: 'invited', email: input.email, role: input.role, delivery: invitation.delivery } }));
    return { ...invitation, id: out.issued.id };
  }

  /** Reenvía una invitación de equipo pendiente: reemplaza el token (el enlace anterior deja de valer) y conserva rol y ajustes. Respeta la espera entre reenvíos. */
  async resendMemberInvitation(invitationId: string): Promise<InvitationIssued & { id: string }> {
    const c = TenantContext.current();
    if (!c.userId) throw new ForbiddenError();
    const orgId = c.organizationId;
    const linkBase = this.linkBase();
    const out = await this.db.withIdentity(async (tx) => {
      const [row] = await tx
        .select({ id: invitations.id, email: invitations.email, role: invitations.role, setup: invitations.setup, lastSentAt: invitations.lastSentAt, orgName: organizations.name })
        .from(invitations)
        .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
        .where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, orgId), isNull(invitations.consumedAt)))
        .for('update', { of: invitations })
        .limit(1);
      // 404 uniforme: de otra empresa, ya aceptada, cancelada o inexistente
      if (!row || (row.role !== 'client_admin' && row.role !== 'advisor') || setupOf(row.setup)?.cancelled) throw new NotFoundError();
      const wait = this.cfg.invite.resendCooldownMs - (Date.now() - row.lastSentAt.getTime());
      if (wait > 0) throw new TooManyAttemptsError(Math.ceil(wait / 1000));
      const issued = await this.issue(tx, { organizationId: orgId, email: row.email, role: row.role, invitedBy: c.userId!, setup: setupOf(row.setup) });
      await tx.insert(memberHistory).values({ organizationId: orgId, userId: null, changedBy: c.userId, kind: 'invited', before: null, after: { event: 'resent', email: row.email, role: row.role } });
      return { orgName: row.orgName, email: row.email, issued };
    });
    const invitation = await this.deliver(linkBase, out.email, out.orgName, out.issued, 'client');
    await this.safely('team.invitation_resent', () => this.clientAudit.record({ entityType: 'user', entityId: out.issued.id, field: 'invitation', newValue: { event: 'resent', email: out.email, delivery: invitation.delivery } }));
    return { ...invitation, id: out.issued.id };
  }

  /** Cancela una invitación de equipo pendiente: el enlace deja de valer. Cancelar una que no existe, de otra empresa o ya aceptada es un 404. */
  async cancelMemberInvitation(invitationId: string): Promise<{ id: string; cancelled: true }> {
    const c = TenantContext.current();
    if (!c.userId) throw new ForbiddenError();
    const orgId = c.organizationId;
    const email = await this.db.withIdentity(async (tx) => {
      const [row] = await tx
        .select({ email: invitations.email, role: invitations.role, setup: invitations.setup })
        .from(invitations)
        .where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, orgId), isNull(invitations.consumedAt)))
        .for('update')
        .limit(1);
      if (!row || (row.role !== 'client_admin' && row.role !== 'advisor') || setupOf(row.setup)?.cancelled) throw new NotFoundError();
      const cur = setupOf(row.setup) ?? { grant: [], deny: [], queue_ids: [] };
      await tx.update(invitations).set({ setup: { ...cur, cancelled: true }, expiresAt: new Date() }).where(eq(invitations.id, invitationId));
      await tx.insert(memberHistory).values({ organizationId: orgId, userId: null, changedBy: c.userId, kind: 'invitation_cancelled', before: { email: row.email, role: row.role }, after: null });
      return row.email;
    });
    await this.safely('team.invitation_cancelled', () => this.clientAudit.record({ entityType: 'user', entityId: invitationId, field: 'invitation', newValue: { event: 'cancelled', email } }));
    return { id: invitationId, cancelled: true };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private linkBase(): string {
    const base = this.cfg.frontend.inviteLinkBase;
    if (base === undefined) throw new ServiceUnavailableError('INVITATIONS_UNAVAILABLE', 'Las invitaciones no están disponibles: falta configurar la URL del frontend');
    return base;
  }

  private async guardIp(ip?: string): Promise<void> {
    const r = await this.limiter.hit(this.limiter.keyFor('i', ip ?? 'unknown'), this.cfg.invite.attemptIpMaxPerHour);
    if (!r.allowed) throw new TooManyAttemptsError(r.retryAfterSeconds);
  }

  /** Crea o reemplaza la invitación de (organización, correo). Devuelve el token en claro SOLO para el correo/enlace. */
  private async issue(tx: IdentityTx, input: { organizationId: string; email: string; role: string; invitedBy: string; setup?: MemberSetup | null }): Promise<{ token: string; expiresAt: Date; id: string }> {
    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.cfg.invite.ttlMs);
    const values = { id, tokenHash: hashSecret(secret), expiresAt, consumedAt: null, acceptedUserId: null, invitedBy: input.invitedBy, role: input.role, lastSentAt: now, ...(input.setup !== undefined ? { setup: input.setup } : {}) };
    await tx
      .insert(invitations)
      .values({ organizationId: input.organizationId, email: input.email, ...values })
      .onConflictDoUpdate({ target: [invitations.organizationId, invitations.email], set: { ...values, sentCount: sql`${invitations.sentCount} + 1` } });
    return { token: `${id}.${secret}`, expiresAt, id };
  }

  /** Lee y valida la invitación. Con `lock`, bloquea su fila (FOR UPDATE). Todo fallo de token es el mismo 400, salvo «vencida» (token auténtico). */
  private async loadValid(tx: IdentityTx, id: string, hash: string, lock: boolean): Promise<Loaded> {
    const q = tx
      .select({
        id: invitations.id,
        organizationId: invitations.organizationId,
        orgName: organizations.name,
        orgPlanId: organizations.planId,
        orgStatus: organizations.status,
        orgDeleted: organizations.deletedAt,
        email: invitations.email,
        role: invitations.role,
        invitedBy: invitations.invitedBy,
        tokenHash: invitations.tokenHash,
        expiresAt: invitations.expiresAt,
        consumedAt: invitations.consumedAt,
        setup: invitations.setup,
      })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
      .where(eq(invitations.id, id))
      .limit(1);
    const [row] = await (lock ? q.for('update', { of: invitations }) : q);
    if (!row || !sameHash(row.tokenHash, hash) || row.consumedAt || row.orgStatus !== 'active' || row.orgDeleted) throw new InvalidInvitationError();
    if (row.expiresAt.getTime() <= Date.now()) throw new InvitationExpiredError();
    if (setupOf(row.setup)?.cancelled) throw new InvalidInvitationError();
    return { id: row.id, organizationId: row.organizationId, orgName: row.orgName, orgPlanId: row.orgPlanId, email: row.email, role: row.role, invitedBy: row.invitedBy, expiresAt: row.expiresAt, setup: setupOf(row.setup) };
  }

  /** Envía el correo (si hay proveedor) DESPUÉS de confirmar la transacción. El enlace solo se devuelve cuando el correo no salió. */
  private async deliver(linkBase: string, to: string, orgName: string, issued: { token: string; expiresAt: Date }, kind: 'client' | 'agency' = 'client'): Promise<InvitationIssued> {
    const inviteUrl = `${linkBase}#token=${issued.token}`;
    const base = { email: to, expires_at: issued.expiresAt.toISOString() };
    if (!this.mail.available) return { ...base, delivery: 'unavailable', invite_url: inviteUrl };
    try {
      await this.mail.sendInvitation({ to, organizationName: orgName, kind, inviteUrl, expiresInDays: Math.round(this.cfg.invite.ttlMs / 86_400_000) });
      return { ...base, delivery: 'sent' };
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'MailProvider falló al enviar la invitación');
      return { ...base, delivery: 'failed', invite_url: inviteUrl };
    }
  }

  private async safely(action: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, `auditoría ${action} falló (la operación ya está confirmada)`);
    }
  }
}
