import type { PoolClient } from 'pg';
import { LeakedTransactionError } from './errors';

export interface GuardState {
  /** false cuando la transacción terminó y la conexión volvió al pool. */
  open: boolean;
  /** true cuando el código de negocio terminó: solo se permiten COMMIT/ROLLBACK de Drizzle. */
  sealed: boolean;
}

const END_STMT = /^\s*(commit|rollback)\b/i;

/**
 * Envuelve la conexión que ve Drizzle. Cualquier `query` posterior al fin del ámbito de la transacción
 * (tx filtrada a un setTimeout, a un campo de clase, a una promesa sin esperar...) lanza en lugar de
 * ejecutarse en una conexión ya devuelta al pool y sin contexto.
 */
export function guardClient(client: PoolClient, state: GuardState): PoolClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (...args: unknown[]) => {
          if (!state.open) throw new LeakedTransactionError('la transacción ya terminó (conexión devuelta al pool)');
          if (state.sealed) {
            const first = args[0];
            const text = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text ?? '';
            if (!END_STMT.test(text)) throw new LeakedTransactionError('el callback de la transacción ya terminó');
          }
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
