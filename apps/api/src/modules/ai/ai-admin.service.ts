import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../errors';
import { PlatformContext, TenantContext } from '../../tenant';
import { CompaniesService, OrgDirectoryService } from '../organizations';
import { AiModelPricesService, AiPricingService, PlatformAuditService, type AiPricingView, type ModelPriceView } from '../platform';
import { AiCreditsService, type CreditsView, type LedgerItemPlatformView, type LedgerItemView } from './ai-credits.service';
import type { AdminOrganizationsQuery, GrantDto, MarginDto, ModelPriceDto, PricingDto } from './ai.dto';

export interface AdminOrganizationItem {
  id: string;
  name: string;
  state: string;
  balance: number;
  held: number;
  /** Créditos que han entrado (bienvenida y regalos). */
  granted: number;
  /** Créditos que se han gastado. */
  used: number;
  /** Margen que se aplica a esta empresa (el propio o el global). */
  margin_pct: string;
  margin_override: boolean;
}

export interface AdminOrganizationList {
  items: AdminOrganizationItem[];
  next_cursor: string | null;
  pricing: AiPricingView;
}

/**
 * Créditos IA vistos por el SÚPER ADMIN (M8.1, ADR-19/53): precio y margen, saldos de todas las empresas, regalos y el libro con costo y margen. SOLO rutas de plataforma: nada de esto llega a una
 * respuesta de cliente ni de agencia. Para tocar el monedero de una empresa se entra a SU contexto (RLS) marcando `actingAs: super_admin`, y todo queda en la auditoría de plataforma y en la de la empresa.
 */
@Injectable()
export class AiAdminService {
  constructor(
    @Inject(AiPricingService) private readonly pricing: AiPricingService,
    @Inject(AiModelPricesService) private readonly models: AiModelPricesService,
    @Inject(AiCreditsService) private readonly credits: AiCreditsService,
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  getPricing(): Promise<AiPricingView> {
    return this.pricing.get();
  }

  listModels(): Promise<ModelPriceView[]> {
    return this.models.list();
  }

  setModelPrice(model: string, b: ModelPriceDto): Promise<ModelPriceView> {
    return this.models.set(model, b);
  }

  setPricing(b: PricingDto): Promise<AiPricingView> {
    return this.pricing.set(b);
  }

  /** Las empresas CLIENTE con su saldo (un monedero por empresa se lee bajo su propio contexto). */
  async organizations(q: AdminOrganizationsQuery): Promise<AdminOrganizationList> {
    const list = await this.companies.list({ ...(q.q ? { q: q.q } : {}), ...(q.state ? { state: q.state } : {}), kind: 'client', limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
    const [margins, global] = await Promise.all([this.pricing.orgMargins(list.items.map((i) => i.id)), this.pricing.get()]);
    const items: AdminOrganizationItem[] = [];
    for (const c of list.items) {
      const s = await this.asTenant(c.id, () => this.credits.summary());
      const own = margins.get(c.id);
      items.push({ id: c.id, name: c.name, state: c.state, ...s, margin_pct: own ?? global.global_margin_pct, margin_override: own !== undefined });
    }
    return { items, next_cursor: list.next_cursor, pricing: global };
  }

  async setMargin(organizationId: string, b: MarginDto): Promise<{ id: string; margin_pct: string; margin_override: boolean }> {
    await this.requireClient(organizationId);
    await this.pricing.setOrgMargin(organizationId, b.margin_pct);
    const p = await this.pricing.get();
    return { id: organizationId, margin_pct: b.margin_pct ?? p.global_margin_pct, margin_override: b.margin_pct !== null };
  }

  /** Regala créditos a una empresa. Idempotente por llave. */
  async grant(organizationId: string, b: GrantDto, idempotencyKey: string): Promise<{ item: LedgerItemView; balance: number; replayed: boolean }> {
    await this.requireClient(organizationId);
    const out = await this.asTenant(organizationId, () => this.credits.grant({ credits: b.credits, note: b.note, idempotencyKey }));
    if (!out.replayed) await this.audit.record({ action: 'ai.credits.grant', entityType: 'organization', entityId: organizationId, targetOrgId: organizationId, details: { credits: b.credits, note: b.note, balance: out.balance } });
    return out;
  }

  /** El libro de la empresa con costo y margen (solo plataforma). */
  async ledger(organizationId: string, q: { limit?: number | undefined; cursor?: string | undefined }): Promise<CreditsView<LedgerItemPlatformView>> {
    await this.requireClient(organizationId);
    return this.asTenant(organizationId, () => this.credits.viewForPlatform(q));
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
