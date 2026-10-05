import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import type { AppConfig } from '../config';
import type { AppLogger } from '../logger';
import { PlatformContext, TenantContext } from '../tenant';
import { DatabaseContextMismatchError } from './errors';
import { guardClient, type GuardState } from './guarded-client';
import type { DrizzleTx, IdentityTx, PlatformTx, TenantTx } from './types';

export interface DatabasePools {
  app: Pool;
  platform: Pool;
  identity: Pool;
}

interface ActiveTx {
  kind: 'tenant' | 'platform' | 'identity';
  tx: unknown;
}

/**
 * ÚNICO punto de acceso a datos de la aplicación (ADR-24).
 *  - `withTenant(fn)`: exige TenantContext; abre UNA transacción; fija `app.org_id` con set_config(..., true)
 *    (local a la transacción) como primera sentencia; no acepta organizationId como parámetro.
 *  - `withPlatform(fn)`: exige PlatformContext; usa el rol app_platform (solo tablas de plataforma).
 * No expone pools, clientes ni instancias de drizzle fuera de una transacción.
 */
export class Database {
  private readonly active = new AsyncLocalStorage<ActiveTx>();

  constructor(
    private readonly pools: DatabasePools,
    private readonly log?: AppLogger,
  ) {
    for (const [name, pool] of Object.entries(pools)) {
      pool.on('error', (err: Error) => this.log?.error({ err, pool: name }, 'error en conexión inactiva del pool'));
    }
  }

  static create(cfg: AppConfig, log?: AppLogger): Database {
    const mk = (connectionString: string, max: number) =>
      new Pool({ connectionString, max, application_name: 'sales-smart-api' });
    return new Database(
      {
        app: mk(cfg.db.appUrl, cfg.db.appPoolMax),
        platform: mk(cfg.db.platformUrl, cfg.db.platformPoolMax),
        identity: mk(cfg.db.identityUrl, cfg.db.identityPoolMax),
      },
      log,
    );
  }

  async withTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const ctx = TenantContext.current(); // lanza MissingTenantContextError si no hay contexto
    return this.run('tenant', this.pools.app, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.org_id', ${ctx.organizationId}, true)`);
    }, fn as (tx: DrizzleTx) => Promise<T>);
  }

  async withPlatform<T>(fn: (tx: PlatformTx) => Promise<T>): Promise<T> {
    PlatformContext.current(); // lanza MissingPlatformContextError si no hay contexto
    return this.run('platform', this.pools.platform, () => Promise.resolve(), fn as (tx: DrizzleTx) => Promise<T>);
  }

  /**
   * Acceso a tablas de IDENTIDAD (ADR-25): login, sesiones, organizaciones, membresías. NO requiere contexto
   * (se usa antes de que exista) y NO puede tocar tablas de negocio ni de plataforma (GRANT del rol app_identity).
   * Solo los módulos `auth` y `organizations` (y el CLI de bootstrap) pueden llamarlo — lint ADR24-P12.
   */
  async withIdentity<T>(fn: (tx: IdentityTx) => Promise<T>): Promise<T> {
    return this.run('identity', this.pools.identity, () => Promise.resolve(), fn as (tx: DrizzleTx) => Promise<T>);
  }

  /** Liveness de la base de datos. No toca datos de negocio ni requiere contexto. */
  async ping(): Promise<void> {
    await this.pools.app.query('SELECT 1');
  }

  async close(): Promise<void> {
    await Promise.all([this.pools.app.end(), this.pools.platform.end(), this.pools.identity.end()]);
  }

  private async run<T>(
    kind: 'tenant' | 'platform' | 'identity',
    pool: Pool,
    prepare: (tx: DrizzleTx) => Promise<void>,
    fn: (tx: DrizzleTx) => Promise<T>,
  ): Promise<T> {
    const outer = this.active.getStore();
    if (outer) {
      // Llamada anidada dentro de una transacción ya abierta: se reutiliza (mismo contexto garantizado
      // porque los contextos no se pueden anidar). Evita agotar el pool y mantiene atomicidad.
      if (outer.kind !== kind) throw new DatabaseContextMismatchError(`${kind} dentro de ${outer.kind}`);
      return fn(outer.tx as DrizzleTx);
    }

    const client: PoolClient = await pool.connect();
    const state: GuardState = { open: true, sealed: false };
    let destroy = false;
    try {
      const d = drizzle(guardClient(client, state));
      return await d.transaction(async (tx) => {
        await prepare(tx);
        try {
          return await this.active.run({ kind, tx }, () => fn(tx));
        } finally {
          state.sealed = true;
        }
      });
    } catch (err) {
      // Asegura que no quede transacción abierta/abortada en la conexión que vuelve al pool.
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy = true;
      }
      throw err;
    } finally {
      state.open = false;
      client.release(destroy);
    }
  }
}
