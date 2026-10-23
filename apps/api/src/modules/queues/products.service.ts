import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { Database, queueProducts, queues, type TenantTx } from '../../db';
import { ConflictError, NotFoundError } from '../../errors';
import { TenantContext } from '../../tenant';
import { writeAudit } from '../audit';
import { OrgDirectoryService } from '../organizations';
import { MAX_PRODUCTS_PER_QUEUE, type CreateProductDto, type UpdateProductDto } from './products.dto';

export interface ProductView {
  id: string;
  queue_id: string;
  name: string;
  kind: 'product' | 'service';
  /** Precio sugerido, texto con 2 decimales en la moneda de la empresa (exacto, no flotante). */
  price: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductList {
  items: ProductView[];
  /** Moneda de la empresa (ISO 4217). */
  currency: string;
  limits: { max_products: number };
}

type Row = typeof queueProducts.$inferSelect;
const AUDIT = 'queue_product';

const view = (r: Row): ProductView => ({
  id: r.id,
  queue_id: r.queueId,
  name: r.name,
  kind: r.kind as ProductView['kind'],
  price: r.price,
  active: r.active,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

/**
 * Catálogo de productos y servicios de una cola (M6.1, ADR-08 #4). Lo administra quien administra las colas; vender con él llega en M6.2. Sin borrado: se desactiva.
 * La empresa sale SIEMPRE del TenantContext y la RLS acota cada consulta; una cola de otra empresa responde 404 uniforme.
 */
@Injectable()
export class ProductsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  async list(queueId: string): Promise<ProductList> {
    const currency = await this.directory.currency();
    const items = await this.db.withTenant(async (tx) => {
      await this.mustQueue(tx, queueId);
      return tx.select().from(queueProducts).where(eq(queueProducts.queueId, queueId)).orderBy(desc(queueProducts.active), asc(sql`lower(${queueProducts.name})`));
    });
    return { items: items.map(view), currency, limits: { max_products: MAX_PRODUCTS_PER_QUEUE } };
  }

  async create(queueId: string, input: CreateProductDto): Promise<ProductView> {
    return this.db
      .withTenant(async (tx) => {
        await this.mustQueue(tx, queueId, true);
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(queueProducts).where(eq(queueProducts.queueId, queueId));
        if ((n?.n ?? 0) >= MAX_PRODUCTS_PER_QUEUE) throw new ConflictError('PRODUCT_LIMIT', `Se alcanzó el máximo de ${MAX_PRODUCTS_PER_QUEUE} productos en esta cola. Desactiva alguno antes de crear otro`);
        const [p] = await tx
          .insert(queueProducts)
          .values({ queueId, name: input.name, kind: input.kind ?? 'product', price: input.price, active: input.active ?? true, createdBy: TenantContext.current().userId ?? null })
          .returning();
        await writeAudit(tx, { entityType: AUDIT, entityId: p!.id, newValue: { queue_id: queueId, name: p!.name, kind: p!.kind, price: p!.price, active: p!.active }, source: 'manual' });
        return view(p!);
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
  }

  async update(queueId: string, productId: string, input: UpdateProductDto): Promise<ProductView> {
    return this.db
      .withTenant(async (tx) => {
        const [cur] = await tx
          .select()
          .from(queueProducts)
          .where(and(eq(queueProducts.id, productId), eq(queueProducts.queueId, queueId)))
          .for('update')
          .limit(1);
        if (!cur) throw new NotFoundError();
        const set: Partial<typeof queueProducts.$inferInsert> = {};
        const audits: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        const change = (field: 'name' | 'kind' | 'price' | 'active', before: unknown, next: unknown) => {
          if (next === undefined || next === before) return;
          (set as Record<string, unknown>)[field] = next;
          audits.push({ field, oldValue: before, newValue: next });
        };
        change('name', cur.name, input.name);
        change('kind', cur.kind, input.kind);
        change('price', cur.price, input.price);
        change('active', cur.active, input.active);
        if (audits.length === 0) return view(cur);
        const [p] = await tx
          .update(queueProducts)
          .set({ ...set, updatedAt: new Date() })
          .where(eq(queueProducts.id, productId))
          .returning();
        for (const a of audits) await writeAudit(tx, { entityType: AUDIT, entityId: productId, field: a.field, oldValue: a.oldValue, newValue: a.newValue, source: 'manual' });
        return view(p!);
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
  }

  /** La cola debe existir y estar vigente en esta empresa (la RLS ya excluye las de otra); `lock` evita que dos altas simultáneas se pasen del tope. */
  private async mustQueue(tx: TenantTx, queueId: string, lock = false): Promise<void> {
    const q = tx.select({ id: queues.id }).from(queues).where(and(eq(queues.id, queueId), isNull(queues.deletedAt))).limit(1);
    const [row] = await (lock ? q.for('update') : q);
    if (!row) throw new NotFoundError();
  }

  private nameTaken(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'queue_products_queue_name_uq' ? new ConflictError('PRODUCT_EXISTS', 'Ya hay un producto con ese nombre en esta cola') : undefined;
  }
}
