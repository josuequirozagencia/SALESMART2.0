import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { aiOrgPricing, aiPricing, Database } from '../../db';
import { PlatformContext, TenantContext } from '../../tenant';
import { PlatformAuditService } from './platform-audit.service';

/** Usuario «del sistema» para lecturas de plataforma que no vienen de una persona (el descuento de créditos en la ruta del cliente). Solo lectura: nunca firma una auditoría. */
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const CACHE_MS = 30_000;

/** Lo que cuesta un crédito y el margen que se aplica a una empresa. SOLO servidor: jamás viaja en una respuesta de cliente ni de agencia (ADR-19). */
export interface AiPrice {
  readonly usdPerCredit: number;
  readonly marginPct: number;
  /** ¿La empresa tiene un margen propio (y no el global)? */
  readonly orgOverride: boolean;
}

export interface AiPricingView {
  usd_per_credit: string;
  global_margin_pct: string;
  updated_at: string;
}

/**
 * Precio y margen de los créditos IA (M8.1, ADR-19/ADR-53). Tablas de PLATAFORMA: solo el rol `app_platform`. El Súper Admin los cambia; el servicio de créditos los lee al cobrar (con memoria de
 * 30 s por empresa). Costo y margen nunca salen en una respuesta de cliente: los endpoints de este servicio son solo de plataforma.
 */
@Injectable()
export class AiPricingService {
  private readonly cache = new Map<string, { at: number; value: AiPrice }>();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  /** El precio y el margen que valen para esa empresa. Lo puede llamar la ruta del cliente (sin contexto de plataforma): lee como «el sistema». */
  async resolve(organizationId: string, now = Date.now()): Promise<AiPrice> {
    const hit = this.cache.get(organizationId);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const read = () =>
      this.db.withPlatform(async (tx) => {
        const [p] = await tx.select().from(aiPricing).limit(1);
        const [o] = await tx.select({ marginPct: aiOrgPricing.marginPct }).from(aiOrgPricing).where(eq(aiOrgPricing.targetOrgId, organizationId)).limit(1);
        return { p, o };
      });
    // Desde una petición de empresa se sale de su contexto para leer como «el sistema» (los contextos no se anidan)
    const { p, o } = PlatformContext.currentOrNull() ? await read() : await TenantContext.detach(() => PlatformContext.run({ actorUserId: SYSTEM_ACTOR }, read));
    if (!p) throw new Error('ai_pricing sin fila: la migración 0081 la siembra'); // no es un error del cliente
    const value: AiPrice = { usdPerCredit: Number(p.usdPerCredit), marginPct: Number(o?.marginPct ?? p.globalMarginPct), orgOverride: o !== undefined };
    this.cache.set(organizationId, { at: now, value });
    return value;
  }

  async get(): Promise<AiPricingView> {
    const [p] = await this.db.withPlatform((tx) => tx.select().from(aiPricing).limit(1));
    if (!p) throw new Error('ai_pricing sin fila: la migración 0081 la siembra');
    return { usd_per_credit: p.usdPerCredit, global_margin_pct: p.globalMarginPct, updated_at: p.updatedAt.toISOString() };
  }

  async set(input: { usd_per_credit: string; global_margin_pct: string }): Promise<AiPricingView> {
    const actor = PlatformContext.current().actorUserId;
    const before = await this.get();
    await this.db.withPlatform((tx) => tx.update(aiPricing).set({ usdPerCredit: input.usd_per_credit, globalMarginPct: input.global_margin_pct, updatedAt: new Date(), updatedBy: actor }).where(eq(aiPricing.id, 1)));
    this.cache.clear();
    await this.audit.record({ action: 'ai.pricing.update', entityType: 'ai_pricing', details: { before: { usd_per_credit: before.usd_per_credit, global_margin_pct: before.global_margin_pct }, after: input } });
    return this.get();
  }

  /** Los márgenes propios de esas empresas (las que no están usan el global). */
  async orgMargins(orgIds: readonly string[]): Promise<Map<string, string>> {
    if (orgIds.length === 0) return new Map();
    const rows = await this.db.withPlatform((tx) => tx.select({ id: aiOrgPricing.targetOrgId, marginPct: aiOrgPricing.marginPct }).from(aiOrgPricing).where(inArray(aiOrgPricing.targetOrgId, [...orgIds])));
    return new Map(rows.map((r) => [r.id, r.marginPct]));
  }

  /** Margen propio de una empresa; `null` vuelve al global. */
  async setOrgMargin(organizationId: string, marginPct: string | null): Promise<void> {
    const actor = PlatformContext.current().actorUserId;
    const [before] = await this.db.withPlatform((tx) => tx.select({ marginPct: aiOrgPricing.marginPct }).from(aiOrgPricing).where(eq(aiOrgPricing.targetOrgId, organizationId)).limit(1));
    await this.db.withPlatform(async (tx) => {
      if (marginPct === null) await tx.delete(aiOrgPricing).where(eq(aiOrgPricing.targetOrgId, organizationId));
      else await tx.insert(aiOrgPricing).values({ targetOrgId: organizationId, marginPct, updatedBy: actor }).onConflictDoUpdate({ target: aiOrgPricing.targetOrgId, set: { marginPct, updatedAt: new Date(), updatedBy: actor } });
    });
    this.cache.delete(organizationId);
    await this.audit.record({ action: 'ai.org_margin.update', entityType: 'organization', entityId: organizationId, targetOrgId: organizationId, details: { before: before?.marginPct ?? null, after: marginPct } });
  }

  invalidate(): void {
    this.cache.clear();
  }
}
