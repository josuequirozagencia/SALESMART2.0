import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { contactListMembers, contactLists, contacts, type TenantTx } from '../../db';
import type { Scope } from './contacts.repository';

export type ListRow = typeof contactLists.$inferSelect;

/** Consultas de listas de contactos. Todas reciben la transacción del llamador (`withTenant`). */
@Injectable()
export class ContactListsRepository {
  private mine(userId: string): SQL {
    return and(isNull(contactLists.deletedAt), or(eq(contactLists.ownerId, userId), eq(contactLists.shared, true))) as SQL;
  }

  /** Las listas que esta persona puede ver: las suyas y las compartidas. */
  visible(tx: TenantTx, userId: string): Promise<ListRow[]> {
    return tx.select().from(contactLists).where(this.mine(userId)).orderBy(asc(sql`lower(${contactLists.name})`), asc(contactLists.id));
  }

  async visibleById(tx: TenantTx, userId: string, id: string, lock = false): Promise<ListRow | undefined> {
    const q = tx.select().from(contactLists).where(and(eq(contactLists.id, id), this.mine(userId)));
    const [row] = await (lock ? q.for('update') : q).limit(1);
    return row;
  }

  async countOwned(tx: TenantTx, userId: string): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(contactLists).where(and(isNull(contactLists.deletedAt), eq(contactLists.ownerId, userId)));
    return r?.n ?? 0;
  }

  async insert(tx: TenantTx, values: typeof contactLists.$inferInsert): Promise<ListRow> {
    const [row] = await tx.insert(contactLists).values(values).returning();
    return row!;
  }

  async update(tx: TenantTx, id: string, set: Partial<typeof contactLists.$inferInsert>): Promise<ListRow> {
    const [row] = await tx.update(contactLists).set({ ...set, updatedAt: new Date() }).where(eq(contactLists.id, id)).returning();
    return row!;
  }

  /** Contactos de cada lista fija que ESTE alcance puede ver (la lista nunca amplía lo visible). */
  async visibleCounts(tx: TenantTx, scope: Scope, listIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (listIds.length === 0) return out;
    const visible = scope.viewAll ? isNull(contacts.deletedAt) : and(isNull(contacts.deletedAt), eq(contacts.ownerId, scope.userId));
    const rows = await tx
      .select({ listId: contactListMembers.listId, n: sql<number>`count(*)::int` })
      .from(contactListMembers)
      .innerJoin(contacts, and(eq(contacts.organizationId, contactListMembers.organizationId), eq(contacts.id, contactListMembers.contactId)))
      .where(and(inArray(contactListMembers.listId, [...listIds]), visible))
      .groupBy(contactListMembers.listId);
    for (const r of rows) out.set(r.listId, r.n);
    return out;
  }

  async memberTotal(tx: TenantTx, listId: string): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(contactListMembers).where(eq(contactListMembers.listId, listId));
    return r?.n ?? 0;
  }

  /** Agrega y devuelve cuántos se agregaron de verdad (los que ya estaban no cuentan). */
  async addMembers(tx: TenantTx, listId: string, contactIds: readonly string[], userId: string): Promise<number> {
    if (contactIds.length === 0) return 0;
    const rows = await tx.insert(contactListMembers).values(contactIds.map((contactId) => ({ listId, contactId, addedBy: userId }))).onConflictDoNothing().returning({ id: contactListMembers.contactId });
    return rows.length;
  }

  async removeMembers(tx: TenantTx, listId: string, contactIds: readonly string[]): Promise<number> {
    if (contactIds.length === 0) return 0;
    const rows = await tx.delete(contactListMembers).where(and(eq(contactListMembers.listId, listId), inArray(contactListMembers.contactId, [...contactIds]))).returning({ id: contactListMembers.contactId });
    return rows.length;
  }
}
