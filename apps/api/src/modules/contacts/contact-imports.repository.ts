import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { contactImportRows, contactImports, contactPhones, contacts, type TenantTx } from '../../db';

export type ImportRow = typeof contactImports.$inferSelect;
export type StagedRow = typeof contactImportRows.$inferSelect;

/** Consultas de importaciones de contactos. Todas reciben la transacción del llamador (`withTenant`). */
@Injectable()
export class ContactImportsRepository {
  async insert(tx: TenantTx, values: typeof contactImports.$inferInsert): Promise<ImportRow> {
    const [row] = await tx.insert(contactImports).values(values).returning();
    return row!;
  }

  async byId(tx: TenantTx, id: string, lock = false): Promise<ImportRow | undefined> {
    const q = tx.select().from(contactImports).where(eq(contactImports.id, id));
    const [row] = await (lock ? q.for('update') : q).limit(1);
    return row;
  }

  /** La importación vigente (no cancelada) de un archivo con esa huella. */
  async liveByHash(tx: TenantTx, hash: string): Promise<ImportRow | undefined> {
    const [row] = await tx.select().from(contactImports).where(and(eq(contactImports.fileHash, hash), ne(contactImports.status, 'cancelled'))).limit(1);
    return row;
  }

  recent(tx: TenantTx, limit: number): Promise<ImportRow[]> {
    return tx.select().from(contactImports).orderBy(desc(contactImports.createdAt), desc(contactImports.id)).limit(limit);
  }

  async update(tx: TenantTx, id: string, set: Partial<typeof contactImports.$inferInsert>): Promise<ImportRow> {
    const [row] = await tx.update(contactImports).set({ ...set, updatedAt: new Date() }).where(eq(contactImports.id, id)).returning();
    return row!;
  }

  async stagedCount(tx: TenantTx, importId: string): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(contactImportRows).where(eq(contactImportRows.importId, importId));
    return r?.n ?? 0;
  }

  async insertRows(tx: TenantTx, importId: string, rows: ReadonlyArray<{ rowNo: number; data: string[] }>): Promise<void> {
    await tx.insert(contactImportRows).values(rows.map((r) => ({ importId, rowNo: r.rowNo, data: r.data })));
  }

  /** Filas aún sin procesar, en orden; sin `limit` devuelve todas (vista previa). */
  async pending(tx: TenantTx, importId: string, limit?: number): Promise<StagedRow[]> {
    const q = tx.select().from(contactImportRows).where(and(eq(contactImportRows.importId, importId), eq(contactImportRows.status, 'pending'))).orderBy(asc(contactImportRows.rowNo));
    return limit ? q.limit(limit) : q;
  }

  async setRow(tx: TenantTx, importId: string, rowNo: number, set: { status: string; reason?: string | null; contactId?: string | null }): Promise<void> {
    await tx
      .update(contactImportRows)
      .set({ status: set.status, reason: set.reason ?? null, contactId: set.contactId ?? null })
      .where(and(eq(contactImportRows.importId, importId), eq(contactImportRows.rowNo, rowNo)));
  }

  async statusCounts(tx: TenantTx, importId: string): Promise<Record<string, number>> {
    const rows = await tx.select({ status: contactImportRows.status, n: sql<number>`count(*)::int` }).from(contactImportRows).where(eq(contactImportRows.importId, importId)).groupBy(contactImportRows.status);
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Filas rechazadas y omitidas, tal como venían, para el reporte descargable. */
  report(tx: TenantTx, importId: string): Promise<StagedRow[]> {
    return tx.select().from(contactImportRows).where(and(eq(contactImportRows.importId, importId), inArray(contactImportRows.status, ['rejected', 'skipped']))).orderBy(asc(contactImportRows.rowNo));
  }

  /** Minimización de datos: lo ya importado vive en los contactos, no hace falta conservar la fila original. */
  async clearImported(tx: TenantTx, importId: string): Promise<void> {
    await tx.update(contactImportRows).set({ data: null }).where(and(eq(contactImportRows.importId, importId), inArray(contactImportRows.status, ['created', 'updated'])));
  }

  /** Contactos vigentes de la empresa que tienen alguno de estos teléfonos (E.164 → id del contacto). */
  async contactsByPhones(tx: TenantTx, phones: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < phones.length; i += 1000) {
      const chunk = phones.slice(i, i + 1000);
      const rows = await tx
        .select({ e164: contactPhones.e164, contactId: contactPhones.contactId })
        .from(contactPhones)
        .innerJoin(contacts, and(eq(contacts.organizationId, contactPhones.organizationId), eq(contacts.id, contactPhones.contactId)))
        .where(and(inArray(contactPhones.e164, chunk), isNull(contactPhones.deletedAt), isNull(contacts.deletedAt)));
      for (const r of rows) out.set(r.e164, r.contactId);
    }
    return out;
  }
}
