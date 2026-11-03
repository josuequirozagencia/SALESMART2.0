import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { Database, organizationDeletions, organizations } from '../../../db';
import { deletionRecipients, type DeletionRecipient } from './recipients';

/** Un borrado definitivo que le toca a la tarea (ya reclamado: es suyo hasta `purge_lease_until`). */
export interface PurgeJob {
  deletionId: string;
  organizationId: string;
  organizationName: string;
  kind: 'client' | 'agency';
  attempts: number;
  /** Quien eliminó la empresa (el actor que queda en la auditoría de plataforma del borrado definitivo). */
  requestedBy: string;
}

/** Una eliminación a la que le falta menos de 24 horas y aún no se avisó. */
export interface PurgeNotice {
  deletionId: string;
  organizationId: string;
  organizationName: string;
  timezone: string;
  purgeAfter: Date;
  recipients: DeletionRecipient[];
}

export interface StepRow {
  table: string;
  deleted: number;
  remaining: number;
}

/**
 * Acceso a lo que necesita el borrado definitivo (F3c, ADR-59 #10–12) de las tablas de identidad y a sus dos funciones `SECURITY DEFINER`. Vive en `auth` porque solo `auth` y `organizations` pueden tocar identidad
 * (lint P12); quien orquesta el borrado (módulo `company-purge`, con el almacenamiento y Evolution) lo usa por aquí. `app_identity` NO tiene DELETE: todo lo que se borra pasa por esas dos funciones, que se niegan
 * con una empresa viva o antes del plazo.
 */
@Injectable()
export class CompanyPurgeStore {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * Toma el siguiente borrado que toca: uno programado cuyo plazo venció, uno fallido que ya toca reintentar o uno en curso cuyo arrendamiento venció (el proceso que lo llevaba murió). Lo deja `purging` (con lo cual
   * ya no se puede recuperar) y cuenta el intento. Varias instancias pueden correr a la vez: `SKIP LOCKED`.
   */
  async claimDue(now: Date, leaseMs: number): Promise<PurgeJob | null> {
    return this.db.withIdentity(async (tx) => {
      const [next] = await tx
        .select({ id: organizationDeletions.id, organizationId: organizationDeletions.organizationId, organizationName: organizationDeletions.organizationName, requestedBy: organizationDeletions.requestedBy })
        .from(organizationDeletions)
        .where(
          and(
            lte(organizationDeletions.purgeAfter, now),
            or(
              eq(organizationDeletions.state, 'scheduled'),
              and(eq(organizationDeletions.state, 'purge_failed'), or(isNull(organizationDeletions.purgeNextAttemptAt), lte(organizationDeletions.purgeNextAttemptAt, now))),
              and(eq(organizationDeletions.state, 'purging'), or(isNull(organizationDeletions.purgeLeaseUntil), lt(organizationDeletions.purgeLeaseUntil, now))),
            ),
            inArray(organizationDeletions.organizationId, tx.select({ id: organizations.id }).from(organizations).where(inArray(organizations.status, ['deleted', 'purged']))),
          ),
        )
        .orderBy(asc(organizationDeletions.purgeAfter))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!next) return null;
      const [row] = await tx
        .update(organizationDeletions)
        .set({ state: 'purging', purgeAttempts: sql`${organizationDeletions.purgeAttempts} + 1`, purgeLeaseUntil: new Date(now.getTime() + leaseMs), purgeStartedAt: sql`COALESCE(${organizationDeletions.purgeStartedAt}, ${now})`, purgeError: null })
        .where(eq(organizationDeletions.id, next.id))
        .returning({ attempts: organizationDeletions.purgeAttempts });
      const [org] = await tx.select({ kind: organizations.kind }).from(organizations).where(eq(organizations.id, next.organizationId)).limit(1);
      return { deletionId: next.id, organizationId: next.organizationId, organizationName: next.organizationName, kind: org?.kind === 'agency' ? 'agency' : 'client', attempts: row?.attempts ?? 1, requestedBy: next.requestedBy };
    });
  }

  /** Suelta el trabajo SIN marcarlo fallido (se acabó el tiempo de esta pasada pero hay avance): la siguiente pasada lo retoma. */
  async release(deletionId: string): Promise<void> {
    await this.db.withIdentity((tx) => tx.update(organizationDeletions).set({ purgeLeaseUntil: null }).where(and(eq(organizationDeletions.id, deletionId), eq(organizationDeletions.state, 'purging'))));
  }

  /** Renueva el arrendamiento: «sigo trabajando». */
  async heartbeat(deletionId: string, until: Date): Promise<void> {
    await this.db.withIdentity((tx) => tx.update(organizationDeletions).set({ purgeLeaseUntil: until }).where(and(eq(organizationDeletions.id, deletionId), eq(organizationDeletions.state, 'purging'))));
  }

  /** Una pasada de la función de borrado de negocio (hasta 5000 filas por tabla). */
  async step(orgId: string): Promise<StepRow[]> {
    const res = await this.db.withIdentity((tx) => tx.execute<{ table_name: string; deleted: string; remaining: string }>(sql`SELECT table_name, deleted::text AS deleted, remaining::text AS remaining FROM public.purge_company_step(${orgId}::uuid)`));
    return res.rows.map((r) => ({ table: r.table_name, deleted: Number(r.deleted), remaining: Number(r.remaining) }));
  }

  /** La función de borrado de identidad (rutas, invitaciones, sesiones, membresías, personas exclusivas) y la lápida. Se niega si queda algo de negocio. */
  async identity(orgId: string): Promise<Record<string, number>> {
    const res = await this.db.withIdentity((tx) => tx.execute<{ table_name: string; deleted: string }>(sql`SELECT table_name, deleted::text AS deleted FROM public.purge_company_identity(${orgId}::uuid)`));
    return Object.fromEntries(res.rows.map((r) => [r.table_name, Number(r.deleted)]));
  }

  /** Terminó: queda `purged` con la evidencia (filas borradas por tabla, sin datos personales). */
  async complete(deletionId: string, counts: Record<string, unknown>, now: Date): Promise<void> {
    await this.db.withIdentity((tx) =>
      tx
        .update(organizationDeletions)
        .set({ state: 'purged', purgedAt: now, purgeCounts: counts, purgeLeaseUntil: null, purgeError: null, purgeNextAttemptAt: null })
        .where(and(eq(organizationDeletions.id, deletionId), eq(organizationDeletions.state, 'purging'))),
    );
  }

  /** Falló: queda `purge_failed` con un código genérico y se reintenta pasado `retryAfterMs`. La Consola lo muestra. */
  async fail(deletionId: string, code: string, now: Date, retryAfterMs: number): Promise<void> {
    await this.db.withIdentity((tx) =>
      tx
        .update(organizationDeletions)
        .set({ state: 'purge_failed', purgeError: code, purgeLeaseUntil: null, purgeNextAttemptAt: new Date(now.getTime() + retryAfterMs) })
        .where(and(eq(organizationDeletions.id, deletionId), eq(organizationDeletions.state, 'purging'))),
    );
  }

  /** Las eliminaciones a las que les falta 24 horas o menos y aún no se les avisó (con a quién avisar). */
  async dueForNotice(now: Date, limit = 20): Promise<PurgeNotice[]> {
    return this.db.withIdentity(async (tx) => {
      const rows = await tx
        .select({
          deletionId: organizationDeletions.id,
          organizationId: organizations.id,
          organizationName: organizationDeletions.organizationName,
          timezone: organizations.timezone,
          purgeAfter: organizationDeletions.purgeAfter,
          ownerUserId: organizations.ownerUserId,
          parentAgencyId: organizations.parentAgencyId,
          kind: organizations.kind,
        })
        .from(organizationDeletions)
        .innerJoin(organizations, eq(organizations.id, organizationDeletions.organizationId))
        .where(
          and(
            eq(organizationDeletions.state, 'scheduled'),
            eq(organizations.status, 'deleted'),
            isNull(organizationDeletions.noticeSentAt),
            gt(organizationDeletions.purgeAfter, now),
            lte(organizationDeletions.purgeAfter, new Date(now.getTime() + 24 * 3_600_000)),
          ),
        )
        .orderBy(asc(organizationDeletions.purgeAfter))
        .limit(limit);
      const out: PurgeNotice[] = [];
      for (const r of rows) {
        out.push({ deletionId: r.deletionId, organizationId: r.organizationId, organizationName: r.organizationName, timezone: r.timezone, purgeAfter: r.purgeAfter, recipients: await deletionRecipients(tx, r.organizationId, r.kind === 'client' ? r.parentAgencyId : null, r.ownerUserId) });
      }
      return out;
    });
  }

  async markNoticed(deletionId: string, now: Date): Promise<void> {
    await this.db.withIdentity((tx) => tx.update(organizationDeletions).set({ noticeSentAt: now }).where(and(eq(organizationDeletions.id, deletionId), isNull(organizationDeletions.noticeSentAt))));
  }
}
