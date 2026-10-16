import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { Database, organizationMembers, organizationOwnershipHistory, organizations, users } from '../../db';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import type { AppLogger } from '../../logger';
import { MAIL_PROVIDER, type MailProvider } from '../../mail';
import { PlatformContext } from '../../tenant';
import { APP_LOGGER } from '../../tokens';
import { PlatformAuditService } from '../platform';
import { AgencyAccessService } from './agency-access.service';
import type { AssignAgencyDto, ListAgenciesQuery } from './agencies.dto';
import type { AccessLevel } from '../../rbac';

export type AgencyState = 'active' | 'suspended' | 'invited';

export interface AgencyItem {
  id: string;
  name: string;
  state: AgencyState;
  /** Dueño de la agencia o, mientras no acepte, el correo invitado. */
  owner_email: string | null;
  /** Clientes en su cartera. */
  clients: number;
  timezone: string;
  country: string | null;
  created_at: string;
  invitation: { email: string; expires_at: string; expired: boolean } | null;
}

export interface AgencyList {
  items: AgencyItem[];
  next_cursor: string | null;
}

export interface OwnershipHistoryItem {
  id: string;
  organization: { id: string; name: string };
  from: { id: string; name: string } | null;
  to: { id: string; name: string } | null;
  reason: string | null;
  notify_client: boolean;
  changed_by: string | null;
  changed_at: string;
}

export interface AssignAgencyResult {
  id: string;
  agency: { id: string; name: string } | null;
  /** false = ya estaba así (no se escribió nada). */
  changed: boolean;
  /** Avisos enviados al administrador del cliente (0 si no se pidió, no hay proveedor de correo o no tiene administrador aún). */
  notified: number;
}

type AgencyRow = {
  id: string;
  name: string;
  state: AgencyState;
  owner_email: string | null;
  clients: number;
  timezone: string;
  country: string | null;
  created_at: Date | string;
  inv_email: string | null;
  inv_expires_at: Date | string | null;
};
type HistoryRow = {
  id: string;
  org_id: string;
  org_name: string;
  from_id: string | null;
  from_name: string | null;
  to_id: string | null;
  to_name: string | null;
  reason: string | null;
  notify_client: boolean;
  changed_by: string | null;
  changed_at: Date | string;
};

const iso = (d: Date | string): string => new Date(d).toISOString();
const likeEscape = (s: string): string => s.replace(/[!%_]/g, (c) => `!${c}`);

/**
 * Agencias y carteras (M2.4, ADR-22/ADR-40), solo Súper Admin. Todo por `withIdentity` (organizaciones, membresías, usuarios, historial).
 *  - Estado de la agencia DERIVADO: `suspended` (organización no activa) → `invited` (sin personas activas y con invitación pendiente) → `active`.
 *  - Mover un cliente solo cambia `parent_agency_id`; plan, facturación y datos no se tocan. En la MISMA transacción se escribe el historial
 *    (append-only) y se reconcilian los accesos de agencia: quien deja de administrar pierde el acceso al instante.
 *  - Suspender una agencia revoca sus accesos a los clientes (siguen funcionando); reactivarla los restituye.
 *  - La auditoría de plataforma y el aviso por correo van DESPUÉS de confirmar la transacción: un fallo se registra sin deshacer el cambio.
 */
@Injectable()
export class AgenciesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AgencyAccessService) private readonly access: AgencyAccessService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async list(f: ListAgenciesQuery, now = new Date()): Promise<AgencyList> {
    const where: SQL[] = [sql`s.id IS NOT NULL`];
    if (f.cursor) where.push(sql`s.id < ${f.cursor}`);
    if (f.state) where.push(sql`s.state = ${f.state}`);
    if (f.q) {
      const like = `%${likeEscape(f.q)}%`;
      where.push(
        sql`(s.name ILIKE ${like} ESCAPE '!' OR EXISTS (SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = s.id AND m.revoked_at IS NULL AND u.email ILIKE ${like} ESCAPE '!') OR EXISTS (SELECT 1 FROM invitations i WHERE i.organization_id = s.id AND i.consumed_at IS NULL AND i.email ILIKE ${like} ESCAPE '!'))`,
      );
    }
    const rows = await this.db.withIdentity(async (tx) => {
      const res = await tx.execute<AgencyRow>(sql`
        SELECT * FROM (
          SELECT o.id, o.name, o.timezone, o.country, o.created_at,
                 (SELECT count(*)::int FROM organizations c WHERE c.parent_agency_id = o.id AND c.deleted_at IS NULL) AS clients,
                 (SELECT u.email FROM organization_members m JOIN users u ON u.id = m.user_id
                   WHERE m.organization_id = o.id AND m.revoked_at IS NULL AND m.role = 'agency' ORDER BY m.created_at, m.id LIMIT 1) AS owner_email,
                 (SELECT i.email FROM invitations i WHERE i.organization_id = o.id AND i.consumed_at IS NULL ORDER BY i.created_at LIMIT 1) AS inv_email,
                 (SELECT i.expires_at FROM invitations i WHERE i.organization_id = o.id AND i.consumed_at IS NULL ORDER BY i.created_at LIMIT 1) AS inv_expires_at,
                 CASE WHEN o.status <> 'active' THEN 'suspended'
                      WHEN NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.revoked_at IS NULL)
                           AND EXISTS (SELECT 1 FROM invitations i WHERE i.organization_id = o.id AND i.consumed_at IS NULL) THEN 'invited'
                      ELSE 'active' END AS state
            FROM organizations o
           WHERE o.kind = 'agency' AND o.deleted_at IS NULL
        ) s
        WHERE ${sql.join(where, sql` AND `)}
        ORDER BY s.id DESC
        LIMIT ${f.limit + 1}`);
      return res.rows;
    });
    const page = rows.slice(0, f.limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        name: r.name,
        state: r.state,
        owner_email: r.owner_email ?? r.inv_email,
        clients: Number(r.clients),
        timezone: r.timezone,
        country: r.country,
        created_at: iso(r.created_at),
        invitation: r.state === 'invited' && r.inv_email && r.inv_expires_at ? { email: r.inv_email, expires_at: iso(r.inv_expires_at), expired: new Date(r.inv_expires_at).getTime() <= now.getTime() } : null,
      })),
      next_cursor: rows.length > f.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** Suspende o reactiva una agencia. Idempotente. Suspender revoca sus accesos a los clientes; reactivar los restituye. */
  async setSuspended(agencyId: string, suspended: boolean): Promise<{ id: string; state: 'active' | 'suspended'; changed: boolean; revoked: number; granted: number }> {
    const actor = PlatformContext.current().actorUserId;
    const out = await this.db.withIdentity(async (tx) => {
      const [a] = await tx.select({ id: organizations.id, kind: organizations.kind, status: organizations.status, deletedAt: organizations.deletedAt }).from(organizations).where(eq(organizations.id, agencyId)).for('update').limit(1);
      if (!a || a.kind !== 'agency' || a.deletedAt) throw new NotFoundError();
      const target = suspended ? 'suspended' : 'active';
      if (a.status === target) return { changed: false, granted: 0, revoked: 0 };
      await tx.update(organizations).set({ status: target, updatedAt: new Date() }).where(eq(organizations.id, agencyId));
      const r = await this.access.reconcileAgency(tx, agencyId, actor);
      return { changed: true, ...r };
    });
    if (out.changed) {
      await this.safely(suspended ? 'agency.suspended' : 'agency.reactivated', () =>
        this.audit.record({ action: suspended ? 'agency.suspended' : 'agency.reactivated', entityType: 'organization', entityId: agencyId, targetOrgId: agencyId, details: { clients_access_revoked: out.revoked, clients_access_granted: out.granted } }),
      );
    }
    return { id: agencyId, state: suspended ? 'suspended' : 'active', ...out };
  }

  /** Cambia quién administra a un cliente (o lo deja en administración directa con `agency_id: null`). Ver ADR-22 y ADR-40. */
  async assignAgency(orgId: string, input: AssignAgencyDto): Promise<AssignAgencyResult> {
    const actor = PlatformContext.current().actorUserId;
    const out = await this.db.withIdentity(async (tx) => {
      const [org] = await tx.select({ id: organizations.id, name: organizations.name, kind: organizations.kind, parent: organizations.parentAgencyId, deletedAt: organizations.deletedAt }).from(organizations).where(eq(organizations.id, orgId)).for('update').limit(1);
      if (!org || org.kind !== 'client' || org.deletedAt) throw new NotFoundError();
      let target: { id: string; name: string } | null = null;
      if (input.agency_id) {
        const [a] = await tx.select({ id: organizations.id, name: organizations.name, kind: organizations.kind, status: organizations.status, deletedAt: organizations.deletedAt }).from(organizations).where(eq(organizations.id, input.agency_id)).for('share').limit(1);
        if (!a || a.kind !== 'agency' || a.deletedAt) throw new AppError(404, 'AGENCY_NOT_FOUND', 'La agencia no existe');
        if (a.status !== 'active') throw new ConflictError('AGENCY_SUSPENDED', 'La agencia está suspendida: reactívala o elige otra');
        target = { id: a.id, name: a.name };
      }
      if ((org.parent ?? null) === (target?.id ?? null)) return { changed: false as const, org, target };
      let previous: { id: string; name: string } | null = null;
      if (org.parent) {
        const [p] = await tx.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, org.parent)).limit(1);
        previous = p ?? null;
      }
      const now = new Date();
      await tx.update(organizations).set({ parentAgencyId: target?.id ?? null, updatedAt: now }).where(eq(organizations.id, orgId));
      await tx.insert(organizationOwnershipHistory).values({ organizationId: orgId, fromAgencyId: previous?.id ?? null, toAgencyId: target?.id ?? null, reason: input.reason ?? null, notifyClient: input.notify_client, changedBy: actor, changedAt: now });
      const access = await this.access.reconcileClient(tx, orgId, actor, now);
      // Administradores activos del cliente (a quienes se avisa)
      const admins = input.notify_client
        ? await tx
            .select({ email: users.email })
            .from(organizationMembers)
            .innerJoin(users, eq(users.id, organizationMembers.userId))
            .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, 'client_admin'), isNull(organizationMembers.revokedAt), eq(users.status, 'active'), isNull(users.deletedAt)))
        : [];
      return { changed: true as const, org, target, previous, access, admins: admins.map((a) => a.email) };
    });
    if (!out.changed) return { id: orgId, agency: out.target, changed: false, notified: 0 };

    await this.safely('client.agency_changed', () =>
      this.audit.record({
        action: 'client.agency_changed',
        entityType: 'organization',
        entityId: orgId,
        targetOrgId: orgId,
        details: { from_agency_id: out.previous?.id ?? null, to_agency_id: out.target?.id ?? null, reason: input.reason ?? null, notify_client: input.notify_client, access_granted: out.access.granted, access_revoked: out.access.revoked },
      }),
    );
    const notified = await this.notify(out.admins, out.org.name, out.target?.name ?? null, out.previous?.name ?? null);
    return { id: orgId, agency: out.target, changed: true, notified };
  }

  /**
   * Fija el nivel de acceso de la agencia a UN cliente (ADR-41). Cambia el valor del cliente y el de las membresías de agencia vigentes en la MISMA
   * transacción: como el nivel se lee de la membresía en cada petición, rige al instante. Sin agencia no hay nivel que fijar (409).
   */
  async setAccessLevel(orgId: string, level: AccessLevel): Promise<{ id: string; level: AccessLevel; changed: boolean }> {
    const out = await this.db.withIdentity(async (tx) => {
      const [org] = await tx.select({ kind: organizations.kind, parent: organizations.parentAgencyId, level: organizations.agencyAccessLevel, deletedAt: organizations.deletedAt }).from(organizations).where(eq(organizations.id, orgId)).for('update').limit(1);
      if (!org || org.kind !== 'client' || org.deletedAt) throw new NotFoundError();
      if (!org.parent) throw new ConflictError('NO_AGENCY', 'La empresa no tiene una agencia que administre su acceso');
      const now = new Date();
      await tx.update(organizations).set({ agencyAccessLevel: level, updatedAt: now }).where(eq(organizations.id, orgId));
      await tx.update(organizationMembers).set({ accessLevel: level }).where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.role, 'agency'), isNull(organizationMembers.revokedAt)));
      return { changed: org.level !== level, previous: org.level, agencyId: org.parent };
    });
    if (out.changed) {
      await this.safely('client.agency_access_changed', () =>
        this.audit.record({ action: 'client.agency_access_changed', entityType: 'organization', entityId: orgId, targetOrgId: orgId, details: { agency_id: out.agencyId, from: out.previous, to: level } }),
      );
    }
    return { id: orgId, level, changed: out.changed };
  }

  /** Historial de cambios de administración donde la agencia fue origen o destino (más reciente primero, hasta 100). */
  async history(agencyId: string): Promise<{ items: OwnershipHistoryItem[] }> {
    const rows = await this.db.withIdentity(async (tx) => {
      const [a] = await tx.select({ id: organizations.id, kind: organizations.kind }).from(organizations).where(eq(organizations.id, agencyId)).limit(1);
      if (!a || a.kind !== 'agency') throw new NotFoundError();
      const res = await tx.execute<HistoryRow>(sql`
        SELECT h.id, h.organization_id AS org_id, o.name AS org_name, h.from_agency_id AS from_id, f.name AS from_name, h.to_agency_id AS to_id, t.name AS to_name,
               h.reason, h.notify_client, u.email AS changed_by, h.changed_at
          FROM organization_ownership_history h
          JOIN organizations o ON o.id = h.organization_id
          LEFT JOIN organizations f ON f.id = h.from_agency_id
          LEFT JOIN organizations t ON t.id = h.to_agency_id
          LEFT JOIN users u ON u.id = h.changed_by
         WHERE h.from_agency_id = ${agencyId} OR h.to_agency_id = ${agencyId}
         ORDER BY h.changed_at DESC, h.id DESC
         LIMIT 100`);
      return res.rows;
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        organization: { id: r.org_id, name: r.org_name },
        from: r.from_id && r.from_name ? { id: r.from_id, name: r.from_name } : null,
        to: r.to_id && r.to_name ? { id: r.to_id, name: r.to_name } : null,
        reason: r.reason,
        notify_client: r.notify_client,
        changed_by: r.changed_by,
        changed_at: iso(r.changed_at),
      })),
    };
  }

  /** Aviso al administrador del cliente (ADR-22). Sin proveedor de correo no se envía; un fallo se registra y no deshace el cambio. */
  private async notify(emails: string[], organizationName: string, agencyName: string | null, previousAgencyName: string | null): Promise<number> {
    if (emails.length === 0 || !this.mail.available) return 0;
    let sent = 0;
    for (const to of emails) {
      try {
        await this.mail.sendOwnershipChange({ to, organizationName, agencyName, previousAgencyName });
        sent += 1;
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'MailProvider falló al avisar del cambio de administración');
      }
    }
    return sent;
  }

  private async safely(action: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, `auditoría ${action} falló (la operación ya está confirmada)`);
    }
  }
}
