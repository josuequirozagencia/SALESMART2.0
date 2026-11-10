import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { channelAccounts, queues, type TenantTx } from '../../db';
import { AppError } from '../../errors';
import { writeAudit } from '../audit';

/** Un cambio de departamento de una conexión (oficial o QR: las dos son filas de `channel_accounts`). */
export interface ConnectionMove {
  readonly id: string;
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * Reglas COMPARTIDAS del departamento de una conexión (v7, ADR-65). Antes vivían duplicadas en `ConnectionsService` y `QrConnectionsService`; ahora los dos y el endpoint
 * `PUT /v1/queues/:id/connections` usan este servicio. Módulo hoja (solo base de datos y auditoría) para no crear un ciclo entre conexiones, conversaciones y departamentos.
 */
@Injectable()
export class ConnectionQueueService {
  /**
   * ¿El departamento existe en la empresa y no está archivado? (la clave foránea compuesta ya impide uno de otra empresa). `share` bloquea su fila contra un archivado simultáneo: archivar un
   * departamento exige bloquearla, así que no se puede archivar mientras alguien le acaba de mandar una conexión. Cada servicio traduce el «no» a su propio error (los de `PATCH` no cambian).
   */
  async queueExists(tx: TenantTx, id: string, opts: { lock?: 'share' } = {}): Promise<boolean> {
    const q = tx.select({ id: queues.id }).from(queues).where(and(eq(queues.id, id), isNull(queues.deletedAt))).limit(1);
    const [row] = await (opts.lock === 'share' ? q.for('share') : q);
    return row !== undefined;
  }

  /** Lo mismo, con el error del endpoint de departamentos (400). */
  async requireQueue(tx: TenantTx, id: string, opts: { lock?: 'share' } = {}): Promise<void> {
    if (!(await this.queueExists(tx, id, opts))) throw new AppError(400, 'CHANNEL_QUEUE_NOT_FOUND', 'Ese departamento no existe o está archivado');
  }

  /** Aplica los cambios y deja una auditoría por conexión (`queue_id`, anterior y nuevo, `manual`). Las conexiones que no cambian no se tocan. */
  async applyMoves(tx: TenantTx, moves: readonly ConnectionMove[]): Promise<void> {
    for (const m of moves) {
      if (m.from === m.to) continue;
      await tx.update(channelAccounts).set({ queueId: m.to, updatedAt: new Date() }).where(eq(channelAccounts.id, m.id));
      await writeAudit(tx, { entityType: 'channel', entityId: m.id, field: 'queue_id', oldValue: m.from, newValue: m.to, source: 'manual' });
    }
  }
}
