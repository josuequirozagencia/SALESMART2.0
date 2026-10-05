import { Pool } from 'pg';
import { inject } from 'vitest';
import { Database } from '../../src/db';
import { createLogger } from '../../src/logger';
import { TenantContext, PlatformContext } from '../../src/tenant';
import { USER_1 } from './constants';
import type { TestDbInfo } from './global-setup';

export function requireDb(): TestDbInfo {
  const info = inject('testDb');
  if (!info) throw new Error('TEST_PG_ADMIN_URL no definido: los tests de aislamiento requieren PostgreSQL (superusuario). Ver docs/M0_PROGRESO.md');
  return info;
}

export interface TestRig {
  info: TestDbInfo;
  appPool: Pool;
  platformPool: Pool;
  identityPool: Pool;
  db: Database;
  close(): Promise<void>;
}

export function makeRig(opts: { appMax?: number; platformMax?: number; identityMax?: number } = {}): TestRig {
  const info = requireDb();
  const appPool = new Pool({ connectionString: info.rwUrl, max: opts.appMax ?? 4 });
  const platformPool = new Pool({ connectionString: info.platformUrl, max: opts.platformMax ?? 2 });
  const identityPool = new Pool({ connectionString: info.identityUrl, max: opts.identityMax ?? 2 });
  const db = new Database({ app: appPool, platform: platformPool, identity: identityPool }, createLogger({ level: 'silent' }));
  return { info, appPool, platformPool, identityPool, db, close: () => db.close() };
}

export const asOrg = <T>(organizationId: string, fn: () => T): T => TenantContext.run({ organizationId, userId: USER_1 }, fn);
export const asPlatform = <T>(fn: () => T): T => PlatformContext.run({ actorUserId: USER_1 }, fn);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drizzle envuelve los errores de consulta en DrizzleQueryError (message incluye SQL y params; la causa es el error real). */
export function rootCause(e: unknown): unknown {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur instanceof Error && cur.cause !== undefined; i++) cur = cur.cause;
  return cur;
}
export async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return rootCause(e);
  }
  throw new Error('se esperaba un rechazo y la promesa se resolvió');
}
