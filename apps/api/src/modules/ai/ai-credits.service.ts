import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { aiHolds, aiLedger, aiWallets, Database, type TenantTx } from '../../db';
import { ConflictError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { OrgDirectoryService } from '../organizations';
import { AiPricingService } from '../platform';
import { creditsFor } from './credits';

/** Una reserva que nadie cerró en este tiempo se da por perdida (el proceso murió a medias) y deja de apartar créditos. */
export const AI_HOLD_TTL_MS = 15 * 60_000;
export const MAX_GRANT_CREDITS = 1_000_000;

export type LedgerKind = 'welcome' | 'grant' | 'use' | 'test';

/** Lo que ve el CLIENTE de un movimiento: créditos y a qué corresponde. Nunca el costo ni el margen. */
export interface LedgerItemView {
  id: string;
  kind: LedgerKind;
  credits: number;
  balance_after: number;
  ref: string | null;
  created_at: string;
}

/** Lo que ve el SÚPER ADMIN de un movimiento (agrega costo y margen). Solo en la ruta de plataforma. */
export interface LedgerItemPlatformView extends LedgerItemView {
  cost_usd: string | null;
  margin_pct: string | null;
  created_by: string | null;
}

export interface CreditsView<I = LedgerItemView> {
  balance: number;
  /** Apartado por llamadas en curso (reservas activas). */
  held: number;
  /** Lo que se puede gastar ahora: saldo menos lo apartado. */
  available: number;
  items: I[];
  next_cursor: string | null;
}

export interface WalletSummary {
  balance: number;
  held: number;
  granted: number;
  used: number;
}

type LedgerRow = typeof aiLedger.$inferSelect;

const clientItem = (r: LedgerRow): LedgerItemView => ({ id: r.id, kind: r.kind as LedgerKind, credits: r.credits, balance_after: r.balanceAfter, ref: r.ref, created_at: r.createdAt.toISOString() });
const platformItem = (r: LedgerRow): LedgerItemPlatformView => ({ ...clientItem(r), cost_usd: r.costUsd, margin_pct: r.marginPct, created_by: r.createdBy });

/**
 * Créditos IA de la empresa (M8.1, ADR-19/53). El saldo vive en `ai_wallets.balance_cache` y se deriva del libro `ai_ledger` (solo inserción): cada movimiento cambia ambos en la MISMA transacción, con la
 * fila del monedero bloqueada, así que bajo concurrencia nunca queda un saldo negativo. Cobrar es «reservar y liquidar»: `reserve` aparta el peor caso ANTES de llamar al modelo (falla si no alcanza) y
 * `settle` cobra lo realmente usado (nunca más de lo apartado) y libera el resto. El monedero se crea la primera vez que se usa, con los créditos de bienvenida si la empresa es un cliente. Todo corre
 * en el TenantContext de la empresa (RLS); el costo y el margen jamás salen en `view`.
 */
@Injectable()
export class AiCreditsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(AiPricingService) private readonly pricing: AiPricingService,
  ) {}

  // ------------------------------------------------------------------ lectura

  /** Saldo y movimientos de la empresa del contexto, del más reciente al más antiguo (cursor). Sin costo ni margen. */
  async view(q: { limit?: number | undefined; cursor?: string | undefined } = {}): Promise<CreditsView> {
    const page = await this.page(q, true);
    return { ...page, items: page.items.map(clientItem) };
  }

  /** Lo mismo con costo y margen: SOLO para la ruta de plataforma del Súper Admin (corre bajo el contexto de la empresa consultada). */
  async viewForPlatform(q: { limit?: number | undefined; cursor?: string | undefined } = {}): Promise<CreditsView<LedgerItemPlatformView>> {
    const page = await this.page(q, false);
    return { ...page, items: page.items.map(platformItem) };
  }

  /** Resumen del monedero de la empresa del contexto (listado de plataforma). No crea el monedero ni regala nada: sin monedero, ceros. */
  async summary(): Promise<WalletSummary> {
    return this.db.withTenant(async (tx) => {
      const [w] = await tx.select().from(aiWallets).limit(1);
      if (!w) return { balance: 0, held: 0, granted: 0, used: 0 };
      const held = await this.held(tx, new Date());
      const [t] = await tx
        .select({ granted: sql<number>`COALESCE(SUM(${aiLedger.credits}) FILTER (WHERE ${aiLedger.credits} > 0), 0)::int`, used: sql<number>`COALESCE(-SUM(${aiLedger.credits}) FILTER (WHERE ${aiLedger.credits} < 0), 0)::int` })
        .from(aiLedger);
      return { balance: w.balanceCache, held, granted: t?.granted ?? 0, used: t?.used ?? 0 };
    });
  }

  // ------------------------------------------------------------------ regalo

  /**
   * Regala créditos a la empresa del contexto (lo llama el Súper Admin bajo `TenantContext.run` de esa empresa). Idempotente por llave: repetir la misma llave con lo mismo devuelve el movimiento ya
   * hecho; con otros datos, 409. Queda en el libro y en la auditoría de la empresa.
   */
  async grant(input: { credits: number; note: string; idempotencyKey: string }): Promise<{ item: LedgerItemView; balance: number; replayed: boolean }> {
    if (!Number.isInteger(input.credits) || input.credits < 1 || input.credits > MAX_GRANT_CREDITS) throw new ValidationError([{ path: 'credits', code: 'invalid', message: `Un número entero de 1 a ${MAX_GRANT_CREDITS}` }]);
    const welcome = await this.directory.welcomeCredits();
    const userId = TenantContext.current().userId ?? null;
    return this.db.withTenant(async (tx) => {
      const [prior] = await tx.select().from(aiLedger).where(eq(aiLedger.idempotencyKey, input.idempotencyKey)).limit(1);
      if (prior) {
        if (prior.kind !== 'grant' || prior.credits !== input.credits || prior.ref !== input.note || prior.createdBy !== userId) throw new ConflictError('IDEMPOTENCY_MISMATCH', 'Esa llave ya se usó con otros datos');
        const [w] = await tx.select().from(aiWallets).limit(1);
        return { item: clientItem(prior), balance: w?.balanceCache ?? prior.balanceAfter, replayed: true };
      }
      const w = await this.lockWallet(tx, welcome);
      const balance = w.balanceCache + input.credits;
      const [row] = await tx.insert(aiLedger).values({ kind: 'grant', credits: input.credits, balanceAfter: balance, ref: input.note, idempotencyKey: input.idempotencyKey, createdBy: userId, createdAt: new Date() }).returning();
      await tx.update(aiWallets).set({ balanceCache: balance, updatedAt: new Date() }).where(eq(aiWallets.id, w.id));
      await writeAudit(tx, { entityType: 'ai_wallet', entityId: w.id, field: 'credits', oldValue: w.balanceCache, newValue: balance, source: 'manual' });
      return { item: clientItem(row!), balance, replayed: false };
    });
  }

  // ------------------------------------------------------------------ cobro

  /**
   * Aparta `credits` ANTES de llamar al modelo. Falla con 409 `AI_NO_CREDITS` si el saldo disponible (saldo menos lo apartado por otras llamadas) no alcanza; así, con cualquier cantidad de llamadas a la
   * vez, la suma de lo apartado nunca supera el saldo. Devuelve el id de la reserva para liquidarla o liberarla.
   */
  async reserve(input: { credits: number; kind: 'use' | 'test'; ref?: string }): Promise<{ holdId: string }> {
    if (!Number.isInteger(input.credits) || input.credits < 1) throw new ValidationError([{ path: 'credits', code: 'invalid', message: 'Un número entero mayor que cero' }]);
    const welcome = await this.directory.welcomeCredits();
    return this.db.withTenant(async (tx) => {
      const w = await this.lockWallet(tx, welcome);
      const now = new Date();
      await this.expireStale(tx, now);
      const held = await this.held(tx, now);
      if (w.balanceCache - held < input.credits) throw new ConflictError('AI_NO_CREDITS', 'No hay créditos suficientes para esta operación');
      const [h] = await tx.insert(aiHolds).values({ credits: input.credits, kind: input.kind, ref: input.ref?.slice(0, 200) ?? null, createdAt: now }).returning({ id: aiHolds.id });
      return { holdId: h!.id };
    });
  }

  /**
   * Cobra lo realmente usado (`costUsd`, el costo real del proveedor) contra la reserva: créditos = `⌈costo × (1 + margen) ÷ valor del crédito⌉`, nunca más de lo apartado. Escribe el movimiento (con el
   * costo y el margen, solo para el servidor), baja el saldo y cierra la reserva. Repetir sobre una reserva ya liquidada no cobra de nuevo.
   */
  async settle(holdId: string, usage: { costUsd: number; ref?: string }): Promise<{ credits: number; balance: number }> {
    const organizationId = TenantContext.current().organizationId;
    const userId = TenantContext.current().userId ?? null;
    const price = await this.pricing.resolve(organizationId); // plataforma: se lee ANTES de la transacción de negocio
    const wanted = creditsFor(usage.costUsd, price.marginPct, price.usdPerCredit);
    return this.db.withTenant(async (tx) => {
      const [wallet] = await tx.select().from(aiWallets).for('update').limit(1);
      if (!wallet) throw new ConflictError('AI_HOLD_CLOSED', 'Esa reserva no existe');
      const [hold] = await tx.select().from(aiHolds).where(eq(aiHolds.id, holdId)).for('update').limit(1);
      if (!hold) throw new ConflictError('AI_HOLD_CLOSED', 'Esa reserva no existe');
      if (hold.status === 'settled') return { credits: 0, balance: wallet.balanceCache };
      // Activa: se cobra hasta lo apartado. Vencida o liberada (la llamada terminó tarde): se cobra lo que alcance, sin pasar de cero
      const cap = hold.status === 'active' ? hold.credits : wallet.balanceCache;
      const charge = Math.min(wanted, cap, wallet.balanceCache);
      const now = new Date();
      let balance = wallet.balanceCache;
      if (charge > 0) {
        balance = wallet.balanceCache - charge;
        await tx.insert(aiLedger).values({ kind: hold.kind, credits: -charge, balanceAfter: balance, ref: (usage.ref ?? hold.ref)?.slice(0, 200) ?? null, costUsd: usage.costUsd.toFixed(6), marginPct: price.marginPct.toFixed(2), createdBy: userId, createdAt: now });
        await tx.update(aiWallets).set({ balanceCache: balance, updatedAt: now }).where(eq(aiWallets.id, wallet.id));
      }
      await tx.update(aiHolds).set({ status: 'settled', settledAt: now }).where(eq(aiHolds.id, holdId));
      return { credits: charge, balance };
    });
  }

  /** Libera una reserva que no se usó (la llamada al modelo falló antes de gastar). Si ya estaba cerrada, no hace nada. */
  async release(holdId: string): Promise<void> {
    await this.db.withTenant(async (tx) => {
      await tx.update(aiHolds).set({ status: 'released', settledAt: new Date() }).where(and(eq(aiHolds.id, holdId), eq(aiHolds.status, 'active')));
    });
  }

  // ------------------------------------------------------------------ interno

  private async page(q: { limit?: number | undefined; cursor?: string | undefined }, ensure: boolean): Promise<CreditsView<LedgerRow>> {
    const limit = q.limit ?? 30;
    const cur = this.decodeCursor(q.cursor);
    // Ver el saldo por primera vez crea el monedero con la bienvenida (la persona ve lo que realmente tiene); la consulta de plataforma nunca crea nada
    if (ensure) await this.ensureWelcome();
    return this.db.withTenant(async (tx) => {
      const [w] = await tx.select().from(aiWallets).limit(1);
      const held = w ? await this.held(tx, new Date()) : 0;
      const conds = cur ? [or(lt(aiLedger.createdAt, cur.at), and(eq(aiLedger.createdAt, cur.at), lt(aiLedger.id, cur.id)))!] : [];
      const rows = await tx.select().from(aiLedger).where(conds.length ? and(...conds) : undefined).orderBy(desc(aiLedger.createdAt), desc(aiLedger.id)).limit(limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const balance = w?.balanceCache ?? 0;
      return { balance, held, available: Math.max(balance - held, 0), items, next_cursor: rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null };
    });
  }

  /** Crea el monedero con la bienvenida si aún no existe (idempotente y seguro con llamadas a la vez). */
  async ensureWelcome(welcomeCredits?: number): Promise<void> {
    const welcome = welcomeCredits ?? (await this.directory.welcomeCredits());
    await this.db.withTenant(async (tx) => {
      await this.lockWallet(tx, welcome);
    });
  }

  /** El monedero bloqueado para escribir. Si no existe, lo crea (con la bienvenida) y lo bloquea; dos llamadas a la vez no duplican la bienvenida (índice único por empresa). */
  private async lockWallet(tx: TenantTx, welcome: number): Promise<typeof aiWallets.$inferSelect> {
    const [existing] = await tx.select().from(aiWallets).for('update').limit(1);
    if (existing) return existing;
    const now = new Date();
    const [created] = await tx.insert(aiWallets).values({ balanceCache: welcome, createdAt: now, updatedAt: now }).onConflictDoNothing().returning();
    if (created) {
      if (welcome > 0) await tx.insert(aiLedger).values({ kind: 'welcome', credits: welcome, balanceAfter: welcome, ref: 'Créditos de bienvenida', createdAt: now });
      return created;
    }
    // Otra transacción lo creó a la vez: se espera su bloqueo y se usa ese
    const [raced] = await tx.select().from(aiWallets).for('update').limit(1);
    if (!raced) throw new Error('no se pudo crear el monedero de créditos');
    return raced;
  }

  private async held(tx: TenantTx, now: Date): Promise<number> {
    const [r] = await tx
      .select({ n: sql<number>`COALESCE(SUM(${aiHolds.credits}), 0)::int` })
      .from(aiHolds)
      .where(and(eq(aiHolds.status, 'active'), sql`${aiHolds.createdAt} >= ${new Date(now.getTime() - AI_HOLD_TTL_MS)}`));
    return r?.n ?? 0;
  }

  private async expireStale(tx: TenantTx, now: Date): Promise<void> {
    await tx
      .update(aiHolds)
      .set({ status: 'expired', settledAt: now })
      .where(and(eq(aiHolds.status, 'active'), lt(aiHolds.createdAt, new Date(now.getTime() - AI_HOLD_TTL_MS))));
  }

  private decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
    if (!raw) return null;
    const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|');
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor no válido' }]);
    return { at, id };
  }
}
