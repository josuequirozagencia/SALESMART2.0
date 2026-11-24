import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { storageGrants, type TenantTx } from '../../db';

export interface QuotaSummary {
  /** Lo que incluye la empresa (lo fija el Súper Admin en su ficha). */
  included_bytes: number;
  /** La suma del espacio extra vigente ahora. */
  extra_bytes: number;
  /** Lo que de verdad puede usar: incluido + extra vigente. Se DERIVA al consultar; nunca es un campo editable. */
  effective_bytes: number;
  /** Cuándo vence el próximo espacio extra con fecha de fin (null si ninguno vence). */
  next_expiry_at: string | null;
}

/**
 * El cupo efectivo de la biblioteca (V21b, ADR-75): cupo incluido + las concesiones de espacio extra vigentes ahora (`starts_at <= ahora < ends_at`) y no anuladas. Corre DENTRO de la transacción de
 * la empresa (su RLS), así que jamás ve las concesiones de otra. Un plan vencido o anulado deja de sumar solo; no se borra ni se bloquea nada de lo ya subido.
 */
@Injectable()
export class StorageQuotaService {
  async quotaIn(tx: TenantTx, includedBytes: number, now = new Date()): Promise<QuotaSummary> {
    const revoke = alias(storageGrants, 'revoke');
    const [r] = await tx
      .select({ extra: sql<string>`coalesce(sum(${storageGrants.extraBytes}), 0)::bigint`, next: sql<Date | null>`min(${storageGrants.endsAt})` })
      .from(storageGrants)
      .where(
        and(
          eq(storageGrants.kind, 'grant'),
          lte(storageGrants.startsAt, now),
          or(isNull(storageGrants.endsAt), gt(storageGrants.endsAt, now)),
          notExists(tx.select({ one: sql`1` }).from(revoke).where(and(eq(revoke.kind, 'revoke'), eq(revoke.revokesGrantId, storageGrants.id)))),
        ),
      );
    const extra = Number(r?.extra ?? 0);
    const next = r?.next ? new Date(r.next) : null;
    return { included_bytes: includedBytes, extra_bytes: extra, effective_bytes: includedBytes + extra, next_expiry_at: next ? next.toISOString() : null };
  }
}
