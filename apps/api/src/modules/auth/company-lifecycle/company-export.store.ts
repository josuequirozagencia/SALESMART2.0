import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { companyExports, Database, organizationDeletions, organizationMembers, organizations, users, type IdentityTx } from '../../../db';

/** Cuántas veces se reintenta armar un paquete antes de darlo por fallido. */
export const EXPORT_MAX_ATTEMPTS = 3;

export interface ExportPart {
  n: number;
  key: string;
  filename: string;
  bytes: number;
  entries: number;
}

export type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface ExportRow {
  id: string;
  organizationId: string;
  deletionId: string;
  requestedBy: string;
  requestedVia: 'platform' | 'owner';
  state: ExportState;
  attempts: number;
  parts: ExportPart[];
  counts: Record<string, unknown>;
  error: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date | null;
  readyNoticeAt: Date | null;
}

/** Una eliminación vigente (programada, dentro de su plazo) con lo que hace falta para operar sobre ella. */
export interface LiveDeletion {
  deletionId: string;
  organizationId: string;
  organizationName: string;
  timezone: string;
  purgeAfter: Date;
  ownerUserId: string | null;
}

export interface ExportOwner {
  userId: string;
  email: string;
}

/** El hash con el que se guarda y se busca el token del enlace del dueño (el token en sí nunca se guarda). */
export const hashExportToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const COLUMNS = {
  id: companyExports.id,
  organizationId: companyExports.organizationId,
  deletionId: companyExports.deletionId,
  requestedBy: companyExports.requestedBy,
  requestedVia: companyExports.requestedVia,
  state: companyExports.state,
  attempts: companyExports.attempts,
  parts: companyExports.parts,
  counts: companyExports.counts,
  error: companyExports.error,
  requestedAt: companyExports.requestedAt,
  startedAt: companyExports.startedAt,
  finishedAt: companyExports.finishedAt,
  expiresAt: companyExports.expiresAt,
  readyNoticeAt: companyExports.readyNoticeAt,
};

type Raw = Omit<ExportRow, 'requestedVia' | 'state' | 'parts' | 'counts'> & { requestedVia: string; state: string; parts: unknown; counts: unknown };
const shape = (r: Raw): ExportRow => ({ ...r, requestedVia: r.requestedVia as ExportRow['requestedVia'], state: r.state as ExportState, parts: r.parts as ExportPart[], counts: r.counts as Record<string, unknown> });

/**
 * Acceso a los pedidos de «Descargar todo» (F3b, ADR-59 #8/#9) en la tabla de identidad `company_exports` y a las eliminaciones que los habilitan. Vive en `auth` porque solo `auth` y `organizations` pueden
 * tocar identidad (lint P12); quien arma el paquete (módulo `company-export`) lo usa por aquí y no ve más identidad que esto.
 */
@Injectable()
export class CompanyExportStore {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** La eliminación programada y vigente de una empresa (dentro del plazo de 7 días), o null. */
  async liveDeletionOf(orgId: string, now = new Date()): Promise<LiveDeletion | null> {
    return this.db.withIdentity((tx) => this.liveDeletion(tx, eq(organizationDeletions.organizationId, orgId), now));
  }

  /**
   * La eliminación a la que apunta el token de un correo del dueño (por su huella), si sigue programada y vigente. Hay dos clases de token: el del correo de eliminación (pide y baja la copia) y el del correo
   * «tu copia está lista» (de un paquete concreto). Ambos llevan a la misma eliminación; ninguno vale cuando la empresa se recupera o se borra.
   */
  async liveDeletionByToken(token: string, now = new Date()): Promise<LiveDeletion | null> {
    const h = hashExportToken(token);
    return this.db.withIdentity((tx) =>
      this.liveDeletion(tx, or(eq(organizationDeletions.exportTokenHash, h), inArray(organizationDeletions.id, tx.select({ id: companyExports.deletionId }).from(companyExports).where(eq(companyExports.downloadTokenHash, h))))!, now),
    );
  }

  private async liveDeletion(tx: IdentityTx, where: SQL, now: Date): Promise<LiveDeletion | null> {
    const [row] = await tx
      .select({ deletionId: organizationDeletions.id, organizationId: organizations.id, organizationName: organizationDeletions.organizationName, timezone: organizations.timezone, purgeAfter: organizationDeletions.purgeAfter, ownerUserId: organizations.ownerUserId })
      .from(organizationDeletions)
      .innerJoin(organizations, eq(organizations.id, organizationDeletions.organizationId))
      .where(and(where, eq(organizationDeletions.state, 'scheduled'), eq(organizations.status, 'deleted'), sql`${organizationDeletions.purgeAfter} > ${now}`))
      .limit(1);
    return row ?? null;
  }

  /** La persona dueña: `owner_user_id` o, si no consta, el primer administrador vigente. Solo si puede iniciar sesión. */
  async ownerOf(deletion: Pick<LiveDeletion, 'organizationId' | 'ownerUserId'>): Promise<ExportOwner | null> {
    return this.db.withIdentity(async (tx) => {
      if (deletion.ownerUserId) {
        const [o] = await tx.select({ userId: users.id, email: users.email }).from(users).where(and(eq(users.id, deletion.ownerUserId), eq(users.status, 'active'), isNull(users.deletedAt))).limit(1);
        if (o) return o;
      }
      const [a] = await tx
        .select({ userId: users.id, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(and(eq(organizationMembers.organizationId, deletion.organizationId), eq(organizationMembers.role, 'client_admin'), isNull(organizationMembers.revokedAt), eq(users.status, 'active'), isNull(users.deletedAt)))
        .orderBy(asc(organizationMembers.createdAt), asc(organizationMembers.id))
        .limit(1);
      return a ?? null;
    });
  }

  /** Las personas que tuvieron acceso a la empresa (para entender «responsable», «creado por»…): sin contraseñas ni nada de acceso. */
  async people(orgId: string): Promise<Array<{ id: string; email: string; full_name: string | null; role: string; status: string }>> {
    const rows = await this.db.withIdentity((tx) =>
      tx
        .select({ id: users.id, email: users.email, fullName: users.fullName, role: organizationMembers.role, revokedAt: organizationMembers.revokedAt })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(eq(organizationMembers.organizationId, orgId))
        .orderBy(asc(organizationMembers.createdAt), asc(organizationMembers.id)),
    );
    return rows.map((r) => ({ id: r.id, email: r.email, full_name: r.fullName, role: r.role, status: r.revokedAt ? 'revoked' : 'active' }));
  }

  /** El último pedido de la empresa. */
  async latest(orgId: string): Promise<ExportRow | null> {
    const [r] = await this.db.withIdentity((tx) => tx.select(COLUMNS).from(companyExports).where(eq(companyExports.organizationId, orgId)).orderBy(desc(companyExports.requestedAt), desc(companyExports.id)).limit(1));
    return r ? shape(r) : null;
  }

  async byId(id: string): Promise<ExportRow | null> {
    const [r] = await this.db.withIdentity((tx) => tx.select(COLUMNS).from(companyExports).where(eq(companyExports.id, id)).limit(1));
    return r ? shape(r) : null;
  }

  /**
   * Pide un paquete. «Uno a la vez»: si ya hay uno en curso o listo (sin vencer), se devuelve ese en vez de crear otro. Dos pedidos a la vez no crean dos (índice único). `created` dice si este pedido fue el que lo creó.
   */
  async enqueue(input: { organizationId: string; deletionId: string; requestedBy: string; via: 'platform' | 'owner' }, now = new Date()): Promise<{ row: ExportRow; created: boolean }> {
    return this.db.withIdentity(async (tx) => {
      // Se serializa por empresa con el bloqueo de su fila de eliminación: dos pedidos a la vez no se pisan
      await tx.select({ id: organizationDeletions.id }).from(organizationDeletions).where(eq(organizationDeletions.id, input.deletionId)).for('update');
      const [open] = await tx
        .select(COLUMNS)
        .from(companyExports)
        .where(and(eq(companyExports.organizationId, input.organizationId), or(inArray(companyExports.state, ['queued', 'running']), and(eq(companyExports.state, 'ready'), sql`${companyExports.expiresAt} > ${now}`))))
        .orderBy(desc(companyExports.requestedAt))
        .limit(1);
      if (open) return { row: shape(open), created: false };
      const [row] = await tx
        .insert(companyExports)
        .values({ organizationId: input.organizationId, deletionId: input.deletionId, requestedBy: input.requestedBy, requestedVia: input.via, requestedAt: now })
        .returning(COLUMNS);
      return { row: shape(row!), created: true };
    });
  }

  /** Toma el siguiente trabajo: uno en cola o uno cuyo arrendamiento venció (el proceso que lo llevaba murió). Cuenta el intento. */
  async claim(now: Date, leaseMs: number): Promise<ExportRow | null> {
    return this.db.withIdentity(async (tx) => {
      const [next] = await tx
        .select({ id: companyExports.id })
        .from(companyExports)
        .where(or(eq(companyExports.state, 'queued'), and(eq(companyExports.state, 'running'), lt(companyExports.leaseUntil, now))))
        .orderBy(asc(companyExports.requestedAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!next) return null;
      const [row] = await tx
        .update(companyExports)
        .set({ state: 'running', attempts: sql`${companyExports.attempts} + 1`, leaseUntil: new Date(now.getTime() + leaseMs), startedAt: now })
        .where(eq(companyExports.id, next.id))
        .returning(COLUMNS);
      return row ? shape(row) : null;
    });
  }

  /** Renueva el arrendamiento: «sigo trabajando». */
  async heartbeat(id: string, until: Date): Promise<void> {
    await this.db.withIdentity((tx) => tx.update(companyExports).set({ leaseUntil: until }).where(and(eq(companyExports.id, id), eq(companyExports.state, 'running'))));
  }

  async complete(id: string, result: { parts: ExportPart[]; counts: Record<string, unknown> }, now: Date, expiresAt: Date, downloadTokenHash: string | null): Promise<void> {
    await this.db.withIdentity((tx) =>
      tx
        .update(companyExports)
        .set({ state: 'ready', parts: result.parts, counts: result.counts, finishedAt: now, expiresAt, leaseUntil: null, error: null, downloadTokenHash })
        .where(and(eq(companyExports.id, id), eq(companyExports.state, 'running'))),
    );
  }

  /** Un fallo: si quedan intentos vuelve a la cola; si no (o si `final`: no tiene sentido reintentar), queda `failed` con un texto genérico. Devuelve el estado en el que quedó. */
  async fail(id: string, error: string, now: Date, opts: { final?: boolean } = {}): Promise<'queued' | 'failed'> {
    return this.db.withIdentity(async (tx) => {
      const [cur] = await tx.select({ attempts: companyExports.attempts }).from(companyExports).where(eq(companyExports.id, id)).limit(1);
      const final = opts.final === true || (cur?.attempts ?? EXPORT_MAX_ATTEMPTS) >= EXPORT_MAX_ATTEMPTS;
      await tx
        .update(companyExports)
        .set(final ? { state: 'failed', error, finishedAt: now, leaseUntil: null } : { state: 'queued', error, leaseUntil: null })
        .where(and(eq(companyExports.id, id), eq(companyExports.state, 'running')));
      return final ? 'failed' : 'queued';
    });
  }

  /** Marca que ya se avisó al dueño de que está listo. */
  async markNotified(id: string, now: Date): Promise<void> {
    await this.db.withIdentity((tx) => tx.update(companyExports).set({ readyNoticeAt: now }).where(eq(companyExports.id, id)));
  }

  /** Los paquetes listos cuyo plazo de 48 horas ya pasó (sus partes se deben borrar del almacenamiento). */
  async dueToExpire(now: Date, limit = 20): Promise<ExportRow[]> {
    const rows = await this.db.withIdentity((tx) =>
      tx
        .select(COLUMNS)
        .from(companyExports)
        .where(and(eq(companyExports.state, 'ready'), lt(companyExports.expiresAt, now)))
        .orderBy(asc(companyExports.expiresAt))
        .limit(limit),
    );
    return rows.map(shape);
  }

  async markExpired(id: string): Promise<void> {
    await this.db.withIdentity((tx) => tx.update(companyExports).set({ state: 'expired' }).where(and(eq(companyExports.id, id), eq(companyExports.state, 'ready'))));
  }

  /** Nombre y zona horaria de la empresa (para el correo y el LEEME). */
  async orgFacts(orgId: string): Promise<{ name: string; timezone: string } | null> {
    const [d] = await this.db.withIdentity((tx) =>
      tx
        .select({ name: organizationDeletions.organizationName, timezone: organizations.timezone })
        .from(organizationDeletions)
        .innerJoin(organizations, eq(organizations.id, organizationDeletions.organizationId))
        .where(eq(organizationDeletions.organizationId, orgId))
        .orderBy(desc(organizationDeletions.requestedAt))
        .limit(1),
    );
    return d ?? null;
  }
}
