import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { Database, storagePlans } from '../../db';
import { NotFoundError } from '../../errors';
import { PlatformContext, TenantContext } from '../../tenant';
import { PlatformAuditService } from './platform-audit.service';
import { toBytes, type PlanDto, type PlanUpdateDto, type PlanView, type PublicPlanView } from './storage-plans.dto';

/** Lecturas de plataforma que no vienen de una persona (la ruta del cliente que lista los planes): leen como «el sistema». Solo lectura: nunca firma una auditoría. */
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

type Row = typeof storagePlans.$inferSelect;
const view = (r: Row): PlanView => ({ id: r.id, name: r.name, extra_bytes: r.extraBytes, price_amount: r.priceAmount, currency: r.currency, period: r.period as 'monthly', active: r.active, sort: r.sort });
const publicView = (p: PlanView): PublicPlanView => ({ id: p.id, name: p.name, extra_bytes: p.extra_bytes, price_amount: p.price_amount, currency: p.currency, period: p.period });

/**
 * Catálogo de planes de espacio extra (V21b, ADR-75). Tabla de PLATAFORMA: el Súper Admin lo administra; el cliente solo recibe el precio de lista de los planes ACTIVOS. Sin DELETE: un plan se
 * desactiva, y lo ya vendido no cambia (cada concesión guarda su propia copia).
 */
@Injectable()
export class StoragePlansService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
  ) {}

  // ------------------------------------------------------------------ plataforma

  async list(): Promise<{ items: PlanView[] }> {
    const rows = await this.db.withPlatform((tx) => tx.select().from(storagePlans).orderBy(asc(storagePlans.sort), asc(storagePlans.name)));
    return { items: rows.map(view) };
  }

  async create(b: PlanDto): Promise<PlanView> {
    const [row] = await this.db.withPlatform((tx) => tx.insert(storagePlans).values({ name: b.name, extraBytes: toBytes(b.extra_gb), priceAmount: b.price_amount, currency: b.currency, active: b.active, sort: b.sort }).returning());
    await this.audit.record({ action: 'storage.plan.create', entityType: 'storage_plan', entityId: row!.id, details: { name: row!.name, extra_bytes: row!.extraBytes, price_amount: row!.priceAmount, currency: row!.currency } });
    return view(row!);
  }

  async update(id: string, b: PlanUpdateDto): Promise<PlanView> {
    const set: Partial<typeof storagePlans.$inferInsert> = { updatedAt: new Date() };
    if (b.name !== undefined) set.name = b.name;
    if (b.extra_gb !== undefined) set.extraBytes = toBytes(b.extra_gb);
    if (b.price_amount !== undefined) set.priceAmount = b.price_amount;
    if (b.currency !== undefined) set.currency = b.currency;
    if (b.active !== undefined) set.active = b.active;
    if (b.sort !== undefined) set.sort = b.sort;
    const [row] = await this.db.withPlatform((tx) => tx.update(storagePlans).set(set).where(eq(storagePlans.id, id)).returning());
    if (!row) throw new NotFoundError();
    await this.audit.record({ action: 'storage.plan.update', entityType: 'storage_plan', entityId: id, details: { fields: Object.keys(b) } });
    return view(row);
  }

  /** Un plan por id (activo o no): para concesiones y solicitudes. */
  async byId(id: string): Promise<PlanView | null> {
    const [row] = await this.read((tx) => tx.select().from(storagePlans).where(eq(storagePlans.id, id)).limit(1));
    return row ? view(row) : null;
  }

  // ------------------------------------------------------------------ cliente

  /** Los planes activos con su precio de lista. Debe llamarse ANTES de abrir una transacción de empresa. */
  async activeForClients(): Promise<PublicPlanView[]> {
    const rows = await this.read((tx) => tx.select().from(storagePlans).where(eq(storagePlans.active, true)).orderBy(asc(storagePlans.sort), asc(storagePlans.name)));
    return rows.map((r) => publicView(view(r)));
  }

  private read<T>(fn: (tx: Parameters<Parameters<Database['withPlatform']>[0]>[0]) => Promise<T>): Promise<T> {
    const run = () => this.db.withPlatform(fn);
    // Desde una petición o una tarea de empresa se sale de su contexto para leer como «el sistema» (los contextos no se anidan)
    return PlatformContext.currentOrNull() ? run() : TenantContext.detach(() => PlatformContext.run({ actorUserId: SYSTEM_ACTOR }, run));
  }
}
