import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { customFieldDefinitions, customFieldValues, type TenantTx } from '../../db';
import type { ValueColumns } from './field-types';

export type DefinitionRow = typeof customFieldDefinitions.$inferSelect;
export type DefinitionInsert = typeof customFieldDefinitions.$inferInsert;
export type ValueRow = typeof customFieldValues.$inferSelect;

/** Consultas de campos personalizados. TODAS reciben la transacción del llamador (`withTenant`): sin TenantContext no hay conexión ni filas. */
@Injectable()
export class CustomFieldsRepository {
  /** Serializa los cambios de definiciones de una entidad en la organización activa (tope de campos y posiciones sin choques). Se libera al terminar la transacción. */
  async lockEntity(tx: TenantTx, entity: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended((${`custom_fields:${entity}`}::text || ':' || app_org()::text), 0))`);
  }

  list(tx: TenantTx, entity: string, includeArchived: boolean): Promise<DefinitionRow[]> {
    const where = includeArchived ? eq(customFieldDefinitions.entity, entity) : and(eq(customFieldDefinitions.entity, entity), isNull(customFieldDefinitions.archivedAt));
    return tx.select().from(customFieldDefinitions).where(where).orderBy(asc(customFieldDefinitions.position), asc(customFieldDefinitions.id));
  }

  async byId(tx: TenantTx, id: string, lock = false): Promise<DefinitionRow | undefined> {
    const q = tx.select().from(customFieldDefinitions).where(eq(customFieldDefinitions.id, id));
    const [row] = await (lock ? q.for('update') : q).limit(1);
    return row;
  }

  /** Por variable, incluidos los archivados (la variable queda reservada para siempre). */
  async byKey(tx: TenantTx, entity: string, varKey: string): Promise<DefinitionRow | undefined> {
    const [row] = await tx.select().from(customFieldDefinitions).where(and(eq(customFieldDefinitions.entity, entity), eq(customFieldDefinitions.varKey, varKey))).limit(1);
    return row;
  }

  async countActive(tx: TenantTx, entity: string): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(customFieldDefinitions).where(and(eq(customFieldDefinitions.entity, entity), isNull(customFieldDefinitions.archivedAt)));
    return r?.n ?? 0;
  }

  async nextPosition(tx: TenantTx, entity: string): Promise<number> {
    const [r] = await tx.select({ m: sql<number | null>`max(${customFieldDefinitions.position})` }).from(customFieldDefinitions).where(eq(customFieldDefinitions.entity, entity));
    return r?.m === null || r?.m === undefined ? 0 : r.m + 1;
  }

  async insert(tx: TenantTx, values: DefinitionInsert): Promise<DefinitionRow> {
    const [row] = await tx.insert(customFieldDefinitions).values(values).returning();
    return row!;
  }

  async update(tx: TenantTx, id: string, set: Partial<DefinitionInsert>): Promise<DefinitionRow> {
    const [row] = await tx.update(customFieldDefinitions).set({ ...set, updatedAt: new Date() }).where(eq(customFieldDefinitions.id, id)).returning();
    return row!;
  }

  /** Valores de varias entidades para ciertas definiciones. */
  valuesOf(tx: TenantTx, entity: string, entityIds: readonly string[], definitionIds: readonly string[]): Promise<ValueRow[]> {
    if (entityIds.length === 0 || definitionIds.length === 0) return Promise.resolve([]);
    return tx
      .select()
      .from(customFieldValues)
      .where(and(eq(customFieldValues.entity, entity), inArray(customFieldValues.entityId, [...entityIds]), inArray(customFieldValues.definitionId, [...definitionIds])));
  }

  /** Inserta o reemplaza el valor de (entidad, id, definición): todas las columnas se reescriben, así queda UNA sola con valor. */
  async upsertValue(tx: TenantTx, key: { entity: string; entityId: string; definitionId: string }, cols: ValueColumns, userId: string | null): Promise<void> {
    const now = new Date();
    await tx
      .insert(customFieldValues)
      .values({ ...key, ...cols, updatedBy: userId })
      .onConflictDoUpdate({
        target: [customFieldValues.organizationId, customFieldValues.entity, customFieldValues.entityId, customFieldValues.definitionId],
        set: { ...cols, updatedBy: userId, updatedAt: now },
      });
  }
}
