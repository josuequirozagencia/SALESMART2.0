import { AppError, NotFoundError } from '../../errors';
import type { ConnectionMove } from './connection-queue.service';

export interface ConnectionRow {
  readonly id: string;
  /** `evolution` = QR; cualquier otro = número oficial. */
  readonly provider: string;
  readonly queueId: string | null;
}

export type ConnectionKind = 'channel' | 'qr';

/**
 * Calcula, SIN tocar la base, lo que hay que mover para que `queueId` quede con exactamente las conexiones `wanted` (v7, ADR-65). `rows` son las conexiones no eliminadas que ya están en el departamento
 * más las pedidas. Una pedida que no está en `rows` (inexistente, de otra empresa o eliminada) o cuyo tipo no coincide responde 404 uniforme. Las que salen van a `moveTo`; si hay salidas y no hay
 * destino, 400 `DESTINATION_REQUIRED` salvo con `allowUnassigned`; el destino no puede ser el mismo departamento. Que el destino exista y no esté archivado lo comprueba quien llama (necesita la base).
 */
export function planConnectionMoves(input: { queueId: string; wanted: ReadonlyMap<string, ConnectionKind>; rows: readonly ConnectionRow[]; moveTo: string | null; allowUnassigned: boolean }): { moves: ConnectionMove[]; leaving: number; destination: string | null } {
  const byId = new Map(input.rows.map((r) => [r.id, r]));
  for (const [id, kind] of input.wanted) {
    const r = byId.get(id);
    if (!r || (kind === 'qr') !== (r.provider === 'evolution')) throw new NotFoundError();
  }
  const leaving = input.rows.filter((r) => r.queueId === input.queueId && !input.wanted.has(r.id));
  let destination: string | null = null;
  if (leaving.length > 0) {
    if (input.moveTo === null) {
      if (!input.allowUnassigned) throw new AppError(400, 'DESTINATION_REQUIRED', 'Elige a qué departamento pasan las conexiones que quitas (o confirma dejarlas sin departamento)');
    } else {
      if (input.moveTo === input.queueId) throw new AppError(400, 'DESTINATION_SAME', 'El departamento de destino debe ser distinto de este');
      destination = input.moveTo;
    }
  }
  const moves: ConnectionMove[] = [
    ...[...input.wanted.keys()].map((id) => ({ id, from: byId.get(id)!.queueId, to: input.queueId })),
    ...leaving.map((r) => ({ id: r.id, from: r.queueId, to: destination })),
  ].filter((m) => m.from !== m.to);
  return { moves, leaving: leaving.length, destination };
}
