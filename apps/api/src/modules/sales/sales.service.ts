import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { contacts, Database, metaEvents, queueProducts, queues, saleChangeRequests, salePayments, sales, saleStatusHistory, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { AttributionService } from '../attribution';
import { DomainEventBus } from '../events';
import { writeAudit } from '../audit';
import { loadConversation, scopeOf, type InboxAccess } from '../inbox';
import { OpportunitiesService } from '../opportunities';
import { OrgDirectoryService, OrgMembersService, pendingPerson } from '../organizations';
import { RealtimeService } from '../realtime';
import { SlaService } from '../sla';
import {
  MAX_OPEN_REQUESTS_PER_SALE,
  type CancelDto,
  type ChangeRequestDto,
  type CorrectionDto,
  type CreateSaleDto,
  type ListSalesQuery,
  type PaymentDto,
  type RequestsQuery,
  type ResolveRequestDto,
} from './sales.dto';

/** Quién consulta: `viewAll` (`sales.view_all`) ve todas las ventas de la empresa; sin él, solo las suyas (como vendedor). */
export interface SalesScope {
  readonly userId: string;
  readonly viewAll: boolean;
}

export interface PaymentView {
  id: string;
  kind: 'payment' | 'correction';
  amount: string;
  method: string | null;
  note: string | null;
  reason: string | null;
  by: { id: string; name: string } | null;
  created_at: string;
}
export interface HistoryView {
  from: string | null;
  to: string;
  reason: string | null;
  by: { id: string; name: string } | null;
  at: string;
}
export interface ChangeRequestView {
  id: string;
  sale_id: string;
  reason: string;
  status: 'open' | 'resolved' | 'dismissed';
  requested_by: { id: string; name: string } | null;
  resolved_by: { id: string; name: string } | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}
export interface SaleView {
  id: string;
  contact: { id: string; name: string };
  conversation_id: string | null;
  product: { id: string; name: string; kind: 'product' | 'service' };
  quantity: number;
  /** TOTAL de la venta (texto con 2 decimales). */
  amount: string;
  currency: string;
  /** Cobrado hasta ahora: abonos menos correcciones (derivado). */
  paid: string;
  /** Saldo por cobrar: total − cobrado (derivado; cero si la venta se anuló). */
  balance: string;
  /** Cobrada por completo. */
  collected: boolean;
  status: 'active' | 'cancelled';
  seller: { id: string; name: string } | null;
  note: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  open_requests: number;
  /** Lo que se hizo con el Purchase a Meta (`pending`, `sent`, `skipped`, `cancelled`…); null si no hay evento. */
  purchase: string | null;
}
export interface SaleDetail extends SaleView {
  payments: PaymentView[];
  history: HistoryView[];
  change_requests: ChangeRequestView[];
  /** Qué había pasado con el Purchase cuando se anuló (solo en ventas anuladas). */
  purchase_at_cancel: string | null;
  can: { pay: boolean; cancel: boolean; correct: boolean; request_change: boolean };
}
export interface SaleList {
  items: SaleView[];
  next_cursor: string | null;
}
export interface SaleOptions {
  currency: string;
  queue: { id: string; name: string } | null;
  products: Array<{ id: string; name: string; kind: 'product' | 'service'; price: string }>;
  /** Por qué no se puede vender desde esta conversación (null = se puede). */
  blocked: 'no_queue' | 'no_products' | 'unassigned' | 'not_owner' | null;
}

type SaleRow = typeof sales.$inferSelect;
const AUDIT = 'sale';
/** Pasos de dinero en centavos enteros: nunca se suman flotantes. */
const cents = (v: string): number => Math.round(Number(v) * 100);
const fixed = (c: number): string => (c / 100).toFixed(2);

// Referencias CALIFICADAS a mano: con una sola tabla en la consulta, drizzle omite el nombre de tabla en las columnas y la subconsulta compararía consigo misma
const PAID = sql<string>`COALESCE((SELECT SUM(CASE WHEN p.kind = 'payment' THEN p.amount ELSE -p.amount END) FROM ${salePayments} p WHERE p.organization_id = "sales"."organization_id" AND p.sale_id = "sales"."id"), 0)::numeric(14,2)::text`;
const OPEN_REQ = sql<number>`(SELECT count(*)::int FROM ${saleChangeRequests} r WHERE r.organization_id = "sales"."organization_id" AND r.sale_id = "sales"."id" AND r.status = 'open')`;

type Idem = { sale: SaleRow };
const who = pendingPerson;
type Created = { sale: SaleView; created: boolean };

/**
 * Ventas, abonos y saldo (M6.2, ADR-08/18/32/51; F14). Una línea por venta; el TOTAL es lo que se informa a Meta y la base de la comisión. El saldo es DERIVADO: total −
 * abonos + correcciones (en centavos enteros, bajo bloqueo de la fila de la venta: dos abonos simultáneos no pueden pasarse del saldo). Nada se borra ni se edita: se anula
 * con motivo y se corrige con un movimiento. Cada creación y cada abono traen su `Idempotency-Key` (doble clic o reintento de red devuelve lo mismo). La empresa sale SIEMPRE
 * de TenantContext; lo que la persona no ve responde 404, igual que lo inexistente.
 */
@Injectable()
export class SalesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AttributionService) private readonly attribution: AttributionService,
    @Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService,
    @Inject(SlaService) private readonly sla: SlaService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Optional() @Inject(RealtimeService) private readonly realtime?: RealtimeService,
    @Optional() @Inject(DomainEventBus) private readonly events?: DomainEventBus,
  ) {}

  // ------------------------------------------------------------------ opciones del formulario

  /** Lo que el formulario «Registrar venta» de una conversación necesita: la cola, sus productos activos, la moneda y si se puede vender. */
  async options(access: InboxAccess, conversationId: string): Promise<SaleOptions> {
    const currency = await this.directory.currency();
    return this.db.withTenant(async (tx) => {
      const scope = scopeOf(access);
      const { c } = await loadConversation(tx, scope, conversationId);
      const [queue] = c.queueId ? await tx.select({ id: queues.id, name: queues.name }).from(queues).where(and(eq(queues.id, c.queueId), isNull(queues.deletedAt))).limit(1) : [];
      const products = queue
        ? await tx.select().from(queueProducts).where(and(eq(queueProducts.queueId, queue.id), eq(queueProducts.active, true))).orderBy(asc(sql`lower(${queueProducts.name})`))
        : [];
      let blocked: SaleOptions['blocked'] = null;
      if (!queue) blocked = 'no_queue';
      else if (products.length === 0) blocked = 'no_products';
      else if (c.ownerId === null) blocked = 'unassigned';
      else if (c.ownerId !== scope.userId && !scope.viewAll) blocked = 'not_owner';
      return { currency, queue: queue ?? null, products: products.map((p) => ({ id: p.id, name: p.name, kind: p.kind as 'product' | 'service', price: p.price })), blocked };
    });
  }

  // ------------------------------------------------------------------ crear

  async create(access: InboxAccess, key: string, input: CreateSaleDto): Promise<Created> {
    const currency = await this.directory.currency();
    const run = (): Promise<Created> => this.db.withTenant((tx) => this.createIn(tx, access, key, input, currency));
    try {
      return await this.hydrate(await run());
    } catch (e) {
      // Dos peticiones con la misma llave a la vez: gana una y la otra devuelve lo mismo
      if (this.isKeyClash(e, 'sales_org_key_uq')) return this.hydrate(await this.db.withTenant((tx) => this.replay(tx, scopeOf(access), key, input)));
      throw e;
    }
  }

  private async replay(tx: TenantTx, scope: { userId: string }, key: string, input: CreateSaleDto): Promise<Created> {
    const found = await this.byKey(tx, key);
    if (!found) throw new ConflictError('IDEMPOTENCY_CONFLICT', 'Esa llave ya se usó en otra operación');
    this.assertSameRequest(found, scope.userId, input);
    return { sale: await this.viewOne(tx, found.sale.id), created: false };
  }

  private async createIn(tx: TenantTx, access: InboxAccess, key: string, input: CreateSaleDto, currency: string): Promise<Created> {
    const scope = scopeOf(access);
    const prior = await this.byKey(tx, key);
    if (prior) {
      this.assertSameRequest(prior, scope.userId, input);
      return { sale: await this.viewOne(tx, prior.sale.id), created: false };
    }

    const { c } = await loadConversation(tx, scope, input.conversation_id, true);
    if (c.ownerId === null) throw new ConflictError('CONVERSATION_UNASSIGNED', 'La conversación aún no tiene asesor: asígnala o tómala antes de registrar la venta');
    if (c.ownerId !== scope.userId && !scope.viewAll) throw new ForbiddenError('NOT_OWNER', 'Solo quien tiene asignada la conversación, o un administrador, puede registrar la venta');
    if (c.queueId === null) throw new ConflictError('SALE_NO_QUEUE', 'La conversación no pertenece a ninguna cola: sin cola no hay catálogo para vender');
    const [product] = await tx.select().from(queueProducts).where(and(eq(queueProducts.id, input.product_id), eq(queueProducts.queueId, c.queueId))).limit(1);
    if (!product || !product.active) throw new ConflictError('PRODUCT_UNAVAILABLE', 'Ese producto no está disponible en el catálogo de la cola de esta conversación');

    const down = input.down_payment ?? '0.00';
    const now = new Date();
    const [sale] = await tx
      .insert(sales)
      .values({
        contactId: c.contactId,
        conversationId: c.id,
        queueId: c.queueId,
        productId: product.id,
        productName: product.name,
        productKind: product.kind,
        quantity: input.quantity ?? 1,
        amount: input.amount,
        currency,
        sellerId: c.ownerId,
        note: input.note ?? null,
        idempotencyKey: key,
        createdBy: scope.userId,
      })
      .returning();
    const s = sale!;
    await tx.insert(saleStatusHistory).values({ saleId: s.id, fromStatus: null, toStatus: 'active', actorId: scope.userId });
    if (Number(down) > 0) {
      await tx.insert(salePayments).values({ saleId: s.id, kind: 'payment', amount: down, method: input.method!, createdBy: scope.userId });
    }
    await writeAudit(tx, { entityType: AUDIT, entityId: s.id, newValue: { amount: s.amount, currency, product_id: product.id, quantity: s.quantity, seller_id: s.sellerId, down_payment: down }, source: 'manual' });

    // Efectos de la venta (F14): etiqueta Venta + Purchase a Meta por el TOTAL, oportunidad ganada y SLA detenido
    await this.attribution.onSaleTagSet(tx, { contactId: s.contactId, saleId: s.id, amount: Number(s.amount), currency }, now);
    const oppId = await this.opportunities.markWon(tx, s.contactId, scope.userId);
    if (oppId) await tx.update(sales).set({ opportunityId: oppId }).where(eq(sales.id, s.id));
    await this.sla.stopOpen(tx, c.id, 'sale', now);
    await this.events?.emit(tx, { type: 'sale_created', contactId: s.contactId, key: `sale_created:${s.id}`, saleId: s.id, total: String(s.amount) });
    this.realtime?.touchHere(c.id);
    return { sale: await this.viewOne(tx, s.id), created: true };
  }

  // ------------------------------------------------------------------ abonos y correcciones

  async addPayment(scope: SalesScope, saleId: string, key: string, input: PaymentDto): Promise<{ sale: SaleDetail; created: boolean }> {
    const run = () =>
      this.db.withTenant(async (tx) => {
        const [prior] = await tx.select().from(salePayments).where(eq(salePayments.idempotencyKey, key)).limit(1);
        if (prior) {
          if (prior.saleId !== saleId || prior.createdBy !== scope.userId || prior.kind !== 'payment' || prior.amount !== input.amount) throw new ConflictError('IDEMPOTENCY_MISMATCH', 'Esa llave ya se usó con otros datos');
          return { sale: await this.detailOf(tx, scope, saleId), created: false };
        }
        const s = await this.lock(tx, scope, saleId);
        if (s.status === 'cancelled') throw new ConflictError('SALE_CANCELLED', 'La venta está anulada: no admite abonos');
        const balance = cents(s.amount) - cents(await this.paidOf(tx, saleId));
        if (cents(input.amount) > balance) throw new ConflictError('PAYMENT_EXCEEDS_BALANCE', `El abono supera el saldo pendiente (${fixed(balance)})`);
        const [p] = await tx.insert(salePayments).values({ saleId, kind: 'payment', amount: input.amount, method: input.method, note: input.note ?? null, idempotencyKey: key, createdBy: scope.userId }).returning({ id: salePayments.id });
        await writeAudit(tx, { entityType: AUDIT, entityId: saleId, field: 'payment', newValue: { payment_id: p!.id, amount: input.amount, method: input.method }, source: 'manual' });
        return { sale: await this.detailOf(tx, scope, saleId), created: true };
      });
    try {
      return await this.hydrate(await run());
    } catch (e) {
      if (this.isKeyClash(e, 'sale_payments_org_key_uq')) return this.hydrate(await this.db.withTenant(async (tx) => ({ sale: await this.detailOf(tx, scope, saleId), created: false })));
      throw e;
    }
  }

  /** Corrige un abono mal registrado: resta del cobrado (sin tocar el abono original) con motivo. Solo quien administra ventas. */
  async addCorrection(scope: SalesScope, saleId: string, input: CorrectionDto): Promise<SaleDetail> {
    return this.hydrate(await this.correctIn(scope, saleId, input));
  }

  private correctIn(scope: SalesScope, saleId: string, input: CorrectionDto): Promise<SaleDetail> {
    return this.db.withTenant(async (tx) => {
      const s = await this.lock(tx, scope, saleId);
      if (s.status === 'cancelled') throw new ConflictError('SALE_CANCELLED', 'La venta está anulada');
      const paid = cents(await this.paidOf(tx, saleId));
      if (cents(input.amount) > paid) throw new ConflictError('CORRECTION_EXCEEDS_PAID', `La corrección supera lo cobrado (${fixed(paid)})`);
      const [p] = await tx.insert(salePayments).values({ saleId, kind: 'correction', amount: input.amount, reason: input.reason, createdBy: scope.userId }).returning({ id: salePayments.id });
      await writeAudit(tx, { entityType: AUDIT, entityId: saleId, field: 'payment_correction', newValue: { payment_id: p!.id, amount: input.amount }, source: 'manual' });
      return this.detailOf(tx, scope, saleId);
    });
  }

  // ------------------------------------------------------------------ anular

  /**
   * Anula la venta con motivo (solo quien tiene `sales.cancel`). Si el Purchase a Meta aún no salió (ventana de gracia), se cancela y Meta nunca lo recibe; si ya salió, queda
   * anotado en la venta (Meta no tiene un evento estándar de cancelación: ADR-18). El historial y los abonos se conservan.
   */
  async cancel(scope: SalesScope, saleId: string, input: CancelDto): Promise<SaleDetail> {
    return this.hydrate(await this.cancelIn(scope, saleId, input));
  }

  private cancelIn(scope: SalesScope, saleId: string, input: CancelDto): Promise<SaleDetail> {
    return this.db.withTenant(async (tx) => {
      const s = await this.lock(tx, scope, saleId);
      if (s.status === 'cancelled') throw new ConflictError('SALE_ALREADY_CANCELLED', 'La venta ya estaba anulada');
      const cancelled = await this.attribution.cancelPurchase(tx, saleId);
      let atCancel: 'cancelled' | 'sent' | 'skipped' | 'none';
      if (cancelled) atCancel = 'cancelled';
      else {
        const [ev] = await tx.select({ status: metaEvents.status }).from(metaEvents).where(eq(metaEvents.eventId, `purchase:${saleId}`)).limit(1);
        atCancel = !ev ? 'none' : ev.status === 'sent' ? 'sent' : ev.status === 'skipped' ? 'skipped' : 'none';
      }
      const now = new Date();
      await tx.update(sales).set({ status: 'cancelled', cancelledAt: now, cancelledBy: scope.userId, cancelReason: input.reason, purchaseAtCancel: atCancel, updatedAt: now }).where(eq(sales.id, saleId));
      await tx.insert(saleStatusHistory).values({ saleId, fromStatus: 'active', toStatus: 'cancelled', reason: input.reason, actorId: scope.userId });
      await writeAudit(tx, { entityType: AUDIT, entityId: saleId, field: 'status', oldValue: 'active', newValue: { status: 'cancelled', purchase: atCancel }, source: 'manual' });
      return this.detailOf(tx, scope, saleId);
    });
  }

  // ------------------------------------------------------------------ solicitudes de corrección

  async requestChange(scope: SalesScope, saleId: string, input: ChangeRequestDto): Promise<ChangeRequestView> {
    const id = await this.db.withTenant(async (tx) => {
      const s = await this.visible(tx, scope, saleId);
      if (s.status === 'cancelled') throw new ConflictError('SALE_CANCELLED', 'La venta está anulada');
      const [n] = await tx.select({ n: count() }).from(saleChangeRequests).where(and(eq(saleChangeRequests.saleId, saleId), eq(saleChangeRequests.status, 'open')));
      if ((n?.n ?? 0) >= MAX_OPEN_REQUESTS_PER_SALE) throw new ConflictError('REQUEST_LIMIT', 'Ya hay solicitudes abiertas para esta venta: espera a que un administrador las resuelva');
      const [r] = await tx.insert(saleChangeRequests).values({ saleId, requestedBy: scope.userId, reason: input.reason }).returning({ id: saleChangeRequests.id });
      await writeAudit(tx, { entityType: AUDIT, entityId: saleId, field: 'change_request', newValue: { request_id: r!.id }, source: 'manual' });
      return r!.id;
    });
    return this.hydrate(await this.db.withTenant(async (tx) => (await this.requestViews(tx, [id]))[0]!));
  }

  /** Solicitudes de corrección de la empresa (administrador). Por omisión, las abiertas. */
  async listRequests(q: RequestsQuery): Promise<{ items: Array<ChangeRequestView & { sale: { id: string; contact: string; amount: string; currency: string } }> }> {
    return this.hydrate(await this.listRequestsIn(q));
  }

  private listRequestsIn(q: RequestsQuery): Promise<{ items: Array<ChangeRequestView & { sale: { id: string; contact: string; amount: string; currency: string } }> }> {
    return this.db.withTenant(async (tx) => {
      const rows = await tx
        .select({ r: saleChangeRequests, amount: sales.amount, currency: sales.currency, contactName: contacts.name })
        .from(saleChangeRequests)
        .innerJoin(sales, and(eq(sales.organizationId, saleChangeRequests.organizationId), eq(sales.id, saleChangeRequests.saleId)))
        .innerJoin(contacts, and(eq(contacts.organizationId, sales.organizationId), eq(contacts.id, sales.contactId)))
        .where(eq(saleChangeRequests.status, q.status ?? 'open'))
        .orderBy(asc(saleChangeRequests.createdAt))
        .limit(100);
      const views = await this.requestViews(tx, rows.map((x) => x.r.id));
      const byId = new Map(views.map((v) => [v.id, v]));
      return { items: rows.map((x) => ({ ...byId.get(x.r.id)!, sale: { id: x.r.saleId, contact: x.contactName, amount: x.amount, currency: x.currency } })) };
    });
  }

  async resolveRequest(scope: SalesScope, requestId: string, input: ResolveRequestDto): Promise<ChangeRequestView> {
    await this.db.withTenant(async (tx) => {
      const [r] = await tx.select().from(saleChangeRequests).where(eq(saleChangeRequests.id, requestId)).for('update').limit(1);
      if (!r) throw new NotFoundError();
      if (r.status !== 'open') throw new ConflictError('REQUEST_RESOLVED', 'Esa solicitud ya se resolvió');
      await tx.update(saleChangeRequests).set({ status: input.status, resolvedBy: scope.userId, resolvedAt: new Date(), resolutionNote: input.note ?? null }).where(eq(saleChangeRequests.id, requestId));
      await writeAudit(tx, { entityType: AUDIT, entityId: r.saleId, field: 'change_request', oldValue: 'open', newValue: { request_id: requestId, status: input.status }, source: 'manual' });
    });
    return this.hydrate(await this.db.withTenant(async (tx) => (await this.requestViews(tx, [requestId]))[0]!));
  }

  // ------------------------------------------------------------------ consultas

  async list(scope: SalesScope, q: ListSalesQuery): Promise<SaleList> {
    return this.hydrate(await this.listIn(scope, q));
  }

  private listIn(scope: SalesScope, q: ListSalesQuery): Promise<SaleList> {
    const limit = q.limit ?? 25;
    return this.db.withTenant(async (tx) => {
      const conds: SQL[] = [];
      if (!scope.viewAll) conds.push(eq(sales.sellerId, scope.userId));
      else if (q.seller_id) conds.push(eq(sales.sellerId, q.seller_id));
      if (q.status) conds.push(eq(sales.status, q.status));
      if (q.contact_id) conds.push(eq(sales.contactId, q.contact_id));
      if (q.collected === 'yes') conds.push(sql`${sales.status} = 'active' AND ${sales.amount} - ${PAID}::numeric <= 0`);
      if (q.collected === 'no') conds.push(sql`${sales.status} = 'active' AND ${sales.amount} - ${PAID}::numeric > 0`);
      const cur = this.decodeCursor(q.cursor);
      if (cur) conds.push(or(lt(sales.createdAt, cur.at), and(eq(sales.createdAt, cur.at), lt(sales.id, cur.id)))!);
      const rows = await tx.select({ id: sales.id }).from(sales).where(conds.length ? and(...conds) : undefined).orderBy(desc(sales.createdAt), desc(sales.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const items = await this.viewMany(tx, page.map((r) => r.id));
      const last = items.at(-1);
      return { items, next_cursor: rows.length > limit && last ? this.encodeCursor(last.created_at, last.id) : null };
    });
  }

  async get(scope: SalesScope, saleId: string): Promise<SaleDetail> {
    return this.hydrate(await this.db.withTenant((tx) => this.detailOf(tx, scope, saleId)));
  }

  // ------------------------------------------------------------------ ajustes (moneda)

  async settings(): Promise<{ currency: string; locked: boolean }> {
    const currency = await this.directory.currency();
    const locked = await this.db.withTenant(async (tx) => ((await tx.select({ n: count() }).from(sales))[0]?.n ?? 0) > 0);
    return { currency, locked };
  }

  /** Cambia la moneda de la empresa. Con ventas registradas no se puede (los montos ya guardados quedarían en otra moneda): 409. */
  async setCurrency(currency: string): Promise<{ currency: string; locked: boolean }> {
    const cur = await this.settings();
    if (cur.currency === currency) return cur;
    if (cur.locked) throw new ConflictError('CURRENCY_LOCKED', 'Ya hay ventas registradas: la moneda de la empresa no se puede cambiar');
    await this.directory.setCurrency(currency);
    await this.db.withTenant((tx) => writeAudit(tx, { entityType: 'organization', entityId: TenantContext.current().organizationId, field: 'currency', oldValue: cur.currency, newValue: currency, source: 'manual' }));
    return { currency, locked: false };
  }

  // ------------------------------------------------------------------ internos

  private async byKey(tx: TenantTx, key: string): Promise<Idem | null> {
    const [sale] = await tx.select().from(sales).where(eq(sales.idempotencyKey, key)).limit(1);
    return sale ? { sale } : null;
  }

  /** Repetir una llave solo es válido con la misma petición y la misma persona; otra cosa es un error (no se devuelve la venta de otro). */
  private assertSameRequest(found: Idem, userId: string, input: CreateSaleDto): void {
    const s = found.sale;
    if (s.createdBy !== userId) throw new ConflictError('IDEMPOTENCY_CONFLICT', 'Esa llave ya se usó en otra operación');
    if (s.conversationId !== input.conversation_id || s.productId !== input.product_id || s.amount !== input.amount) throw new ConflictError('IDEMPOTENCY_MISMATCH', 'Esa llave ya se usó con otros datos');
  }

  private isKeyClash(e: unknown, constraint: string): boolean {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === constraint;
  }

  /** La venta si esta persona la ve (la suya, o todas con `sales.view_all`); si no, 404. */
  private async visible(tx: TenantTx, scope: SalesScope, id: string): Promise<SaleRow> {
    const [s] = await tx.select().from(sales).where(and(eq(sales.id, id), scope.viewAll ? undefined : eq(sales.sellerId, scope.userId))).limit(1);
    if (!s) throw new NotFoundError();
    return s;
  }

  /** Lo mismo, bloqueando la fila: los abonos y la anulación de una misma venta se atienden de uno en uno. */
  private async lock(tx: TenantTx, scope: SalesScope, id: string): Promise<SaleRow> {
    const [s] = await tx.select().from(sales).where(and(eq(sales.id, id), scope.viewAll ? undefined : eq(sales.sellerId, scope.userId))).for('update').limit(1);
    if (!s) throw new NotFoundError();
    return s;
  }

  private async paidOf(tx: TenantTx, saleId: string): Promise<string> {
    const [r] = await tx.select({ paid: PAID }).from(sales).where(eq(sales.id, saleId)).limit(1);
    return r?.paid ?? '0.00';
  }

  private async detailOf(tx: TenantTx, scope: SalesScope, id: string): Promise<SaleDetail> {
    await this.visible(tx, scope, id);
    const [base] = await this.viewMany(tx, [id]);
    if (!base) throw new NotFoundError();
    const [pays, hist, reqs, [row]] = await Promise.all([
      tx.select().from(salePayments).where(eq(salePayments.saleId, id)).orderBy(asc(salePayments.createdAt), asc(salePayments.id)),
      tx.select().from(saleStatusHistory).where(eq(saleStatusHistory.saleId, id)).orderBy(asc(saleStatusHistory.createdAt), asc(saleStatusHistory.id)),
      tx.select({ id: saleChangeRequests.id }).from(saleChangeRequests).where(eq(saleChangeRequests.saleId, id)).orderBy(desc(saleChangeRequests.createdAt)),
      tx.select({ at: sales.purchaseAtCancel }).from(sales).where(eq(sales.id, id)).limit(1),
    ]);
    const by = who;
    const active = base.status === 'active';
    return {
      ...base,
      payments: pays.map((p) => ({ id: p.id, kind: p.kind as PaymentView['kind'], amount: p.amount, method: p.method, note: p.note, reason: p.reason, by: by(p.createdBy), created_at: p.createdAt.toISOString() })),
      history: hist.map((h) => ({ from: h.fromStatus, to: h.toStatus, reason: h.reason, by: by(h.actorId), at: h.createdAt.toISOString() })),
      change_requests: await this.requestViews(tx, reqs.map((r) => r.id)),
      purchase_at_cancel: row?.at ?? null,
      // La interfaz solo muestra lo que el servidor permitirá (los permisos finos los vuelve a exigir cada ruta)
      can: { pay: active && cents(base.balance) > 0, cancel: active, correct: active && cents(base.paid) > 0, request_change: active },
    };
  }

  private async viewOne(tx: TenantTx, id: string): Promise<SaleView> {
    const [v] = await this.viewMany(tx, [id]);
    if (!v) throw new NotFoundError();
    return v;
  }

  private async viewMany(tx: TenantTx, ids: readonly string[]): Promise<SaleView[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ s: sales, paid: PAID, openRequests: OPEN_REQ, contactName: contacts.name })
      .from(sales)
      .innerJoin(contacts, and(eq(contacts.organizationId, sales.organizationId), eq(contacts.id, sales.contactId)))
      .where(inArray(sales.id, [...ids]));
    const events = await tx.select({ id: metaEvents.eventId, status: metaEvents.status }).from(metaEvents).where(inArray(metaEvents.eventId, ids.map((i) => `purchase:${i}`)));
    const purchase = new Map(events.map((e) => [e.id, e.status]));
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows
      .map((r): SaleView => {
        const total = cents(r.s.amount);
        const paid = cents(r.paid);
        const active = r.s.status === 'active';
        return {
          id: r.s.id,
          contact: { id: r.s.contactId, name: r.contactName },
          conversation_id: r.s.conversationId,
          product: { id: r.s.productId, name: r.s.productName, kind: r.s.productKind as 'product' | 'service' },
          quantity: r.s.quantity,
          amount: r.s.amount,
          currency: r.s.currency,
          paid: r.paid,
          balance: active ? fixed(Math.max(total - paid, 0)) : '0.00',
          collected: active && total - paid <= 0,
          status: r.s.status as 'active' | 'cancelled',
          seller: who(r.s.sellerId),
          note: r.s.note,
          created_at: r.s.createdAt.toISOString(),
          cancelled_at: r.s.cancelledAt?.toISOString() ?? null,
          cancel_reason: r.s.cancelReason,
          open_requests: r.openRequests,
          purchase: purchase.get(`purchase:${r.s.id}`) ?? null,
        };
      })
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  private async requestViews(tx: TenantTx, ids: readonly string[]): Promise<ChangeRequestView[]> {
    if (ids.length === 0) return [];
    const rows = await tx.select().from(saleChangeRequests).where(inArray(saleChangeRequests.id, [...ids])).orderBy(desc(saleChangeRequests.createdAt));
    return rows.map((r) => ({
      id: r.id,
      sale_id: r.saleId,
      reason: r.reason,
      status: r.status as ChangeRequestView['status'],
      requested_by: who(r.requestedBy),
      resolved_by: who(r.resolvedBy),
      resolution_note: r.resolutionNote,
      created_at: r.createdAt.toISOString(),
      resolved_at: r.resolvedAt?.toISOString() ?? null,
    }));
  }

  private hydrate<T>(value: T): Promise<T> {
    return this.members.hydrate(value);
  }

  private encodeCursor(iso: string, id: string): string {
    return Buffer.from(`${iso}|${id}`).toString('base64url');
  }

  private decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
    if (!raw) return null;
    const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|');
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor no válido' }]);
    return { at, id };
  }
}
