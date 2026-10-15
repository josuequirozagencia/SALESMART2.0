import { Inject, Injectable } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { Database, organizations, plans } from '../../db';
import { AppError, ConflictError, NotFoundError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { PlatformAuditService } from '../platform';
import type { ListCompaniesQuery } from './plans.dto';

export type CompanyState = 'trial' | 'trial_expired' | 'active' | 'suspended' | 'invited';

export interface CompanyItem {
  id: string;
  name: string;
  kind: 'client' | 'agency';
  state: CompanyState;
  plan: { id: string; name: string } | null;
  /** Agencia que administra al cliente (`null` = administración directa; las agencias y la plataforma no tienen). */
  agency: { id: string; name: string } | null;
  /** Miembros activos de la organización. */
  users: number;
  owner_email: string | null;
  timezone: string;
  country: string | null;
  created_at: string;
  /** Fin de la prueba mientras la empresa siga en prueba (sin plan). */
  trial_ends_at: string | null;
  /** Invitación pendiente del dueño (solo en estado `invited`, ADR-39). */
  invitation: { email: string; expires_at: string; expired: boolean } | null;
}

export interface CompanyList {
  items: CompanyItem[];
  next_cursor: string | null;
}

type Row = {
  id: string;
  name: string;
  kind: 'client' | 'agency';
  state: CompanyState;
  plan_id: string | null;
  plan_name: string | null;
  agency_id: string | null;
  agency_name: string | null;
  users: number;
  owner_email: string | null;
  timezone: string;
  country: string | null;
  created_at: Date | string;
  trial_ends_at: Date | string | null;
  inv_email: string | null;
  inv_expires_at: Date | string | null;
};

const iso = (d: Date | string): string => new Date(d).toISOString();
/** Escapa % y _ (y el propio escape) para un ILIKE literal; el carácter de escape es «!», sin barras invertidas. */
const likeEscape = (s: string): string => s.replace(/[!%_]/g, (c) => `!${c}`);

/**
 * Empresas de la plataforma (M2.2, ADR-38): lista para el Súper Admin y asignación de plan.
 *  - Estado derivado (no se guarda): `suspended` (organización no activa) → `active` (con plan, o sin prueba como las agencias) →
 *    `trial_expired` / `trial`. Un plan asignado saca a la empresa de la prueba (ADR-38): el cobro es manual hasta decidir la pasarela.
 *  - Toda la consulta va por `withIdentity` (identidad: organizaciones, miembros, usuarios, pruebas y planes) con SQL parametrizado.
 *  - La plataforma misma (kind = platform) nunca aparece ni recibe plan.
 */
@Injectable()
export class CompaniesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async list(f: ListCompaniesQuery, now = new Date()): Promise<CompanyList> {
    const where: SQL[] = [sql`s.id IS NOT NULL`];
    if (f.cursor) where.push(sql`s.id < ${f.cursor}`);
    if (f.kind) where.push(sql`s.kind = ${f.kind}`);
    if (f.state) where.push(sql`s.state = ${f.state}`);
    if (f.agency === 'none') where.push(sql`s.kind = 'client' AND s.agency_id IS NULL`);
    else if (f.agency) where.push(sql`s.agency_id = ${f.agency}`);
    if (f.plan === 'none') where.push(sql`s.plan_id IS NULL`);
    else if (f.plan) where.push(sql`s.plan_id = ${f.plan}`);
    if (f.q) {
      const like = `%${likeEscape(f.q)}%`;
      where.push(
        sql`(s.name ILIKE ${like} ESCAPE '!' OR EXISTS (SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = s.id AND m.revoked_at IS NULL AND u.email ILIKE ${like} ESCAPE '!') OR EXISTS (SELECT 1 FROM invitations i WHERE i.organization_id = s.id AND i.consumed_at IS NULL AND i.email ILIKE ${like} ESCAPE '!'))`,
      );
    }
    const rows = await this.db.withIdentity(async (tx) => {
      const res = await tx.execute<Row>(sql`
        SELECT * FROM (
          SELECT o.id, o.name, o.kind, o.timezone, o.country, o.created_at, o.plan_id, p.name AS plan_name, o.parent_agency_id AS agency_id, ag.name AS agency_name,
                 (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = o.id AND m.revoked_at IS NULL) AS users,
                 (SELECT u.email FROM organization_members m JOIN users u ON u.id = m.user_id
                   WHERE m.organization_id = o.id AND m.revoked_at IS NULL AND m.role IN ('client_admin', 'agency') ORDER BY m.created_at, m.id LIMIT 1) AS owner_email,
                 (SELECT i.email FROM invitations i WHERE i.organization_id = o.id AND i.consumed_at IS NULL ORDER BY i.created_at LIMIT 1) AS inv_email,
                 (SELECT i.expires_at FROM invitations i WHERE i.organization_id = o.id AND i.consumed_at IS NULL ORDER BY i.created_at LIMIT 1) AS inv_expires_at,
                 CASE WHEN o.plan_id IS NULL AND t.id IS NOT NULL THEN t.ends_at END AS trial_ends_at,
                 CASE WHEN o.status <> 'active' THEN 'suspended'
                      WHEN o.kind IN ('client', 'agency') AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.revoked_at IS NULL)
                           AND EXISTS (SELECT 1 FROM invitations i WHERE i.organization_id = o.id AND i.consumed_at IS NULL) THEN 'invited'
                      WHEN o.plan_id IS NOT NULL OR t.id IS NULL THEN 'active'
                      WHEN t.status = 'expired' OR t.ends_at <= ${now} THEN 'trial_expired'
                      ELSE 'trial' END AS state
            FROM organizations o
            LEFT JOIN plans p ON p.id = o.plan_id
            LEFT JOIN organizations ag ON ag.id = o.parent_agency_id
            LEFT JOIN trials t ON t.organization_id = o.id
           WHERE o.kind <> 'platform' AND o.deleted_at IS NULL
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
        kind: r.kind,
        state: r.state,
        plan: r.plan_id && r.plan_name ? { id: r.plan_id, name: r.plan_name } : null,
        agency: r.agency_id && r.agency_name ? { id: r.agency_id, name: r.agency_name } : null,
        users: Number(r.users),
        owner_email: r.owner_email ?? r.inv_email,
        timezone: r.timezone,
        country: r.country,
        created_at: iso(r.created_at),
        trial_ends_at: r.trial_ends_at ? iso(r.trial_ends_at) : null,
        invitation: r.state === 'invited' && r.inv_email && r.inv_expires_at ? { email: r.inv_email, expires_at: iso(r.inv_expires_at), expired: new Date(r.inv_expires_at).getTime() <= now.getTime() } : null,
      })),
      next_cursor: rows.length > f.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Asigna (o quita con `null`) el plan de una empresa. Bloquea la organización y el plan (FOR SHARE: no se puede archivar a la vez).
   * Un plan archivado no se asigna; la plataforma no recibe plan. Devuelve el estado resultante.
   */
  async assignPlan(orgId: string, planId: string | null): Promise<{ id: string; state: CompanyState; plan: { id: string; name: string } | null }> {
    const out = await this.db.withIdentity(async (tx) => {
      const [org] = await tx.select({ id: organizations.id, kind: organizations.kind, planId: organizations.planId }).from(organizations).where(eq(organizations.id, orgId)).for('update').limit(1);
      if (!org || org.kind === 'platform') throw new NotFoundError();
      let plan: { id: string; name: string } | null = null;
      if (planId) {
        const [p] = await tx.select({ id: plans.id, name: plans.name, archivedAt: plans.archivedAt }).from(plans).where(eq(plans.id, planId)).for('share').limit(1);
        if (!p) throw new AppError(404, 'PLAN_NOT_FOUND', 'El plan no existe');
        if (p.archivedAt) throw new ConflictError('PLAN_ARCHIVED', 'El plan está archivado: restáuralo o elige otro');
        plan = { id: p.id, name: p.name };
      }
      await tx.update(organizations).set({ planId, updatedAt: new Date() }).where(eq(organizations.id, org.id));
      return { from: org.planId, plan, orgId: org.id };
    });
    await this.safely(() =>
      this.audit.record({ action: 'company.plan_changed', entityType: 'organization', entityId: out.orgId, targetOrgId: out.orgId, details: { from_plan_id: out.from, to_plan_id: out.plan?.id ?? null } }),
    );
    return { id: out.orgId, state: await this.stateOf(out.orgId), plan: out.plan };
  }

  private async stateOf(orgId: string): Promise<CompanyState> {
    const res = await this.db.withIdentity((tx) =>
      tx.execute<{ state: CompanyState }>(sql`
        SELECT CASE WHEN o.status <> 'active' THEN 'suspended'
                    WHEN o.kind IN ('client', 'agency') AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.revoked_at IS NULL)
                         AND EXISTS (SELECT 1 FROM invitations i WHERE i.organization_id = o.id AND i.consumed_at IS NULL) THEN 'invited'
                    WHEN o.plan_id IS NOT NULL OR t.id IS NULL THEN 'active'
                    WHEN t.status = 'expired' OR t.ends_at <= now() THEN 'trial_expired'
                    ELSE 'trial' END AS state
          FROM organizations o LEFT JOIN trials t ON t.organization_id = o.id WHERE o.id = ${orgId}`),
    );
    return res.rows[0]?.state ?? 'active';
  }

  private async safely(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido' }, 'auditoría company.plan_changed falló (la operación ya está confirmada)');
    }
  }
}
