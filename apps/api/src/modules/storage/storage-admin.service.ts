import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { Database, storageGrants, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { PlatformContext, TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { CompaniesService, OrgDirectoryService } from '../organizations';
import { PlatformAuditService, StoragePlansService, toBytes, type GrantDto, type GrantView, type RequestView, type RevokeDto } from '../platform';
import { openRequestIn, StorageRequestsService } from './storage-requests.service';
import { StorageQuotaService, type QuotaSummary } from './storage-quota.service';

type Row = typeof storageGrants.$inferSelect;

export interface CompanySpace {
  id: string;
  name: string;
  state: string;
  quota: QuotaSummary;
  open_request: RequestView | null;
}

const MAX_ORGS = 1000;

/**
 * Lo que hace el Súper Admin con el espacio de la biblioteca (V21b, ADR-75): conceder (con plan o como regalo), anular y ver las solicitudes. Cobrar es manual. Opera DENTRO de la empresa (su RLS)
 * marcado como Súper Admin, y la auditoría de plataforma lleva quién, qué empresa y el importe de lista —sin datos de clientes—.
 */
@Injectable()
export class StorageAdminService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(StoragePlansService) private readonly plans: StoragePlansService,
    @Inject(StorageRequestsService) private readonly requests: StorageRequestsService,
    @Inject(StorageQuotaService) private readonly quota: StorageQuotaService,
  ) {}

  /** Las empresas cliente con su cupo y su solicitud abierta (una por empresa; se lee bajo el contexto de cada una). Si `onlyRequests`, solo las que tienen una solicitud abierta. */
  async companiesSpace(opts: { onlyRequests?: boolean; q?: string | undefined }): Promise<{ items: CompanySpace[]; truncated: boolean }> {
    const out: CompanySpace[] = [];
    let cursor: string | undefined;
    let seen = 0;
    let truncated = false;
    do {
      const page = await this.companies.list({ ...(opts.q ? { q: opts.q } : {}), kind: 'client', limit: 100, ...(cursor ? { cursor } : {}) });
      for (const c of page.items) {
        if (seen >= MAX_ORGS) {
          truncated = true;
          break;
        }
        seen += 1;
        const included = await this.directory.storageQuotaBytesOf(c.id);
        const s = await this.asTenant(c.id, () => this.db.withTenant(async (tx) => ({ quota: await this.quota.quotaIn(tx, included), request: await openRequestIn(tx) })));
        if (opts.onlyRequests && !s.request) continue;
        out.push({ id: c.id, name: c.name, state: c.state, quota: s.quota, open_request: s.request });
      }
      cursor = truncated ? undefined : (page.next_cursor ?? undefined);
    } while (cursor);
    return { items: out, truncated };
  }

  /** Las concesiones de una empresa (las más nuevas primero), con si siguen vigentes o ya se anularon. */
  async grants(organizationId: string): Promise<{ items: GrantView[]; quota: QuotaSummary }> {
    await this.requireClient(organizationId);
    const included = await this.directory.storageQuotaBytesOf(organizationId);
    return this.asTenant(organizationId, () =>
      this.db.withTenant(async (tx) => {
        const rows = await tx.select().from(storageGrants).orderBy(desc(storageGrants.createdAt), desc(storageGrants.id)).limit(200);
        const now = new Date();
        const revoked = new Set(rows.filter((r) => r.kind === 'revoke').map((r) => r.revokesGrantId));
        return { items: rows.map((r) => grantView(r, now, revoked)), quota: await this.quota.quotaIn(tx, included) };
      }),
    );
  }

  /** Concede espacio extra. Idempotente por llave: reintentar no duplica. Resuelve la solicitud abierta de la empresa. */
  async grant(organizationId: string, b: GrantDto, idempotencyKey: string): Promise<{ item: GrantView; replayed: boolean; quota: QuotaSummary }> {
    await this.requireClient(organizationId);
    const plan = b.plan_id ? await this.plans.byId(b.plan_id) : null; // se lee en el contexto de plataforma, antes de entrar a la empresa
    if (b.plan_id && !plan) throw new NotFoundError();
    const actor = PlatformContext.current().actorUserId;
    const included = await this.directory.storageQuotaBytesOf(organizationId);
    const now = new Date();
    const startsAt = b.starts_at ? new Date(b.starts_at) : now;
    const endsAt = b.ends_at ? new Date(b.ends_at) : null;
    if (endsAt && endsAt <= now) throw new ValidationError([{ path: 'ends_at', code: 'past', message: 'La fecha de fin ya pasó' }]);
    const extraBytes = plan ? plan.extra_bytes : toBytes(b.extra_gb!);
    const out = await this.asTenant(organizationId, () =>
      this.db.withTenant(async (tx) => {
        const [existing] = await tx.select().from(storageGrants).where(eq(storageGrants.idempotencyKey, idempotencyKey)).limit(1);
        if (existing) return { row: existing, replayed: true, quota: await this.quota.quotaIn(tx, included, now) };
        const [row] = await tx
          .insert(storageGrants)
          .values({
            kind: 'grant',
            planId: plan?.id ?? null,
            planName: plan?.name ?? 'Espacio extra (ajuste)',
            extraBytes,
            priceAmount: plan?.price_amount ?? null,
            currency: plan?.currency ?? null,
            startsAt,
            endsAt,
            origin: 'manual',
            grantedBy: actor,
            reason: b.reason ? b.reason : null,
            idempotencyKey,
          })
          .returning();
        await this.requests.resolveOpen(tx, 'granted', actor);
        await writeAudit(tx, { entityType: 'storage_grant', entityId: row!.id, field: 'grant', oldValue: null, newValue: { plan: row!.planName, extra_bytes: extraBytes, ends_at: endsAt?.toISOString() ?? null }, source: 'manual' });
        return { row: row!, replayed: false, quota: await this.quota.quotaIn(tx, included, now) };
      }),
    );
    if (!out.replayed) await this.audit.record({ action: 'storage.grant', entityType: 'organization', entityId: organizationId, targetOrgId: organizationId, details: { plan: out.row.planName, extra_bytes: extraBytes, price_amount: out.row.priceAmount, currency: out.row.currency, ends_at: endsAt?.toISOString() ?? null, gift: !plan } });
    return { item: grantView(out.row, now, new Set()), replayed: out.replayed, quota: out.quota };
  }

  /** Anula una concesión (inserta una fila de anulación; nada se edita ni se borra). El espacio deja de sumar al instante; lo ya subido se conserva. */
  async revoke(organizationId: string, grantId: string, b: RevokeDto): Promise<{ item: GrantView; quota: QuotaSummary }> {
    await this.requireClient(organizationId);
    const actor = PlatformContext.current().actorUserId;
    const included = await this.directory.storageQuotaBytesOf(organizationId);
    const now = new Date();
    const out = await this.asTenant(organizationId, () =>
      this.db.withTenant(async (tx) => {
        const [target] = await tx.select().from(storageGrants).where(and(eq(storageGrants.id, grantId), eq(storageGrants.kind, 'grant'))).limit(1);
        if (!target) throw new NotFoundError();
        const [already] = await tx.select({ id: storageGrants.id }).from(storageGrants).where(eq(storageGrants.revokesGrantId, grantId)).limit(1);
        if (already) throw new ConflictError('GRANT_ALREADY_REVOKED', 'Esta concesión ya estaba anulada');
        const [row] = await tx
          .insert(storageGrants)
          .values({ kind: 'revoke', planName: target.planName, extraBytes: 0, startsAt: now, revokesGrantId: grantId, origin: 'manual', grantedBy: actor, reason: b.reason, idempotencyKey: `revoke:${grantId}` })
          .returning();
        await writeAudit(tx, { entityType: 'storage_grant', entityId: grantId, field: 'revoke', oldValue: { plan: target.planName, extra_bytes: target.extraBytes }, newValue: null, source: 'manual' });
        return { row: row!, target, quota: await this.quota.quotaIn(tx, included, now) };
      }),
    );
    await this.audit.record({ action: 'storage.revoke', entityType: 'organization', entityId: organizationId, targetOrgId: organizationId, details: { plan: out.target.planName, extra_bytes: out.target.extraBytes } });
    return { item: grantView(out.row, now, new Set()), quota: out.quota };
  }

  /** Descarta la solicitud abierta de una empresa sin conceder nada. */
  async dismissRequest(organizationId: string): Promise<{ dismissed: boolean }> {
    await this.requireClient(organizationId);
    const actor = PlatformContext.current().actorUserId;
    const id = await this.asTenant(organizationId, () => this.db.withTenant((tx: TenantTx) => this.requests.resolveOpen(tx, 'dismissed', actor)));
    if (!id) throw new NotFoundError();
    await this.audit.record({ action: 'storage.request.dismiss', entityType: 'organization', entityId: organizationId, targetOrgId: organizationId });
    return { dismissed: true };
  }

  /** Opera DENTRO de la empresa (su RLS) como Súper Admin: sale del contexto de plataforma, entra al de la empresa marcando `actingAs` y vuelve. */
  private asTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    const actor = PlatformContext.current().actorUserId;
    return PlatformContext.detach(() => TenantContext.run({ organizationId, userId: actor, actingAs: 'super_admin' }, fn));
  }

  private async requireClient(organizationId: string): Promise<void> {
    if (!(await this.directory.isClient(organizationId))) throw new NotFoundError();
  }
}

function grantView(r: Row, now: Date, revoked: ReadonlySet<string | null>): GrantView {
  const wasRevoked = revoked.has(r.id);
  const live = r.kind === 'grant' && r.startsAt <= now && (r.endsAt === null || r.endsAt > now) && !wasRevoked;
  return {
    id: r.id,
    kind: r.kind as GrantView['kind'],
    plan_name: r.planName,
    extra_bytes: r.extraBytes,
    price_amount: r.priceAmount,
    currency: r.currency,
    starts_at: r.startsAt.toISOString(),
    ends_at: r.endsAt?.toISOString() ?? null,
    revokes_grant_id: r.revokesGrantId,
    origin: r.origin as GrantView['origin'],
    reason: r.reason,
    created_at: r.createdAt.toISOString(),
    active: live,
    revoked: wasRevoked,
  };
}
