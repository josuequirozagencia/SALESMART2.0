// No existe camino a datos de negocio sin TenantContext; la transacción no puede filtrarse; superficie pública mínima.
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as dbModule from '../../src/db';
import { Database, LeakedTransactionError } from '../../src/db';
import { InvalidContextError, MissingPlatformContextError, MissingTenantContextError, PlatformContext, TenantContext } from '../../src/tenant';
import { contacts, platformSettings } from '../fixtures/schema';
import { ORG_A, ORG_B, USER_1 } from '../support/constants';
import { asOrg, asPlatform, makeRig, rejection, rootCause, sleep } from '../support/harness';

const rig = makeRig({ appMax: 2 });
afterAll(() => rig.close());
const { db } = rig;

describe('TenantContext', () => {
  it('es obligatorio, inmutable y valida UUID', () => {
    expect(() => TenantContext.current()).toThrow(MissingTenantContextError);
    expect(TenantContext.currentOrNull()).toBeNull();
    expect(() => TenantContext.run({ organizationId: 'no-uuid' }, () => 1)).toThrow(InvalidContextError);
    expect(() => TenantContext.run({ organizationId: ORG_A, userId: 'x' }, () => 1)).toThrow(InvalidContextError);
    expect(() => TenantContext.run({ organizationId: ORG_A, actingOrgId: ORG_B }, () => 1)).toThrow(/actingAs/);
    TenantContext.run({ organizationId: ORG_A.toUpperCase(), userId: USER_1 }, () => {
      const c = TenantContext.current();
      expect(c.organizationId).toBe(ORG_A);
      expect(Object.isFrozen(c)).toBe(true);
      expect(() => ((c as { organizationId: string }).organizationId = ORG_B)).toThrow();
      expect(c.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('no se puede anidar (ni con el mismo tenant) ni mezclar con PlatformContext', () => {
    TenantContext.run({ organizationId: ORG_A }, () => {
      expect(() => TenantContext.run({ organizationId: ORG_B }, () => 1)).toThrow(InvalidContextError);
      expect(() => TenantContext.run({ organizationId: ORG_A }, () => 1)).toThrow(InvalidContextError);
      expect(() => PlatformContext.run({ actorUserId: USER_1 }, () => 1)).toThrow(InvalidContextError);
    });
    PlatformContext.run({ actorUserId: USER_1 }, () => {
      expect(() => TenantContext.run({ organizationId: ORG_A }, () => 1)).toThrow(InvalidContextError);
    });
  });

  it('se propaga por async/await y timers, y queda aislado entre peticiones concurrentes', async () => {
    const seen = await Promise.all(
      [ORG_A, ORG_B, ORG_A, ORG_B].map((o) =>
        asOrg(o, async () => {
          await sleep(Math.random() * 10);
          await new Promise<void>((r) => setImmediate(r));
          return TenantContext.current().organizationId;
        }),
      ),
    );
    expect(seen).toEqual([ORG_A, ORG_B, ORG_A, ORG_B]);
  });
});

describe('Database — sin TenantContext no hay acceso', () => {
  it('withTenant sin contexto rechaza (promesa rechazada, nunca excepción síncrona) y no conecta', async () => {
    const connect = vi.spyOn(rig.appPool, 'connect');
    const p = db.withTenant(async (tx) => tx.select().from(contacts));
    await expect(p).rejects.toBeInstanceOf(MissingTenantContextError);
    expect(connect).not.toHaveBeenCalled();
    connect.mockRestore();
  });

  it('withPlatform sin PlatformContext rechaza; con TenantContext activo también', async () => {
    await expect(db.withPlatform(async (tx) => tx.select().from(platformSettings))).rejects.toBeInstanceOf(MissingPlatformContextError);
    await expect(asOrg(ORG_A, () => db.withPlatform(async (tx) => tx.select().from(platformSettings)))).rejects.toBeInstanceOf(MissingPlatformContextError);
  });

  it('withPlatform con contexto accede a tablas de plataforma y NO a tablas de negocio', async () => {
    await asPlatform(() => db.withPlatform((tx) => tx.insert(platformSettings).values({ key: 'k1', value: 'v' })));
    const r = await asPlatform(() => db.withPlatform((tx) => tx.select().from(platformSettings)));
    expect(r).toEqual([{ key: 'k1', value: 'v' }]);
    expect(String(await rejection(asPlatform(() => db.withPlatform((tx) => tx.select().from(contacts))))) ).toMatch(/permission denied/);
    await asPlatform(() => db.withPlatform((tx) => tx.delete(platformSettings)));
  });
});

describe('Database — la transacción no puede filtrarse', () => {
  it('usar `tx` después de terminar lanza LeakedTransactionError (no ejecuta en una conexión sin contexto)', async () => {
    let leaked: Parameters<Parameters<Database['withTenant']>[0]>[0] | undefined;
    await asOrg(ORG_A, () => db.withTenant(async (tx) => { leaked = tx; }));
    expect(await rejection(leaked!.select().from(contacts))).toBeInstanceOf(LeakedTransactionError);
    expect(await rejection(leaked!.execute(sql`SELECT 1`))).toBeInstanceOf(LeakedTransactionError);
  });

  it('una consulta lanzada sin esperar (timer) que corre tras terminar el callback es rechazada', async () => {
    let late: unknown;
    await asOrg(ORG_A, () =>
      db.withTenant(async (tx) => {
        setImmediate(() => { tx.execute(sql`SELECT 1`).catch((e: unknown) => { late = rootCause(e); }); });
      }),
    );
    await sleep(50);
    expect(late).toBeInstanceOf(LeakedTransactionError);
  });

  it('withTenant devuelve el valor del callback y propaga errores tal cual', async () => {
    expect(await asOrg(ORG_A, () => db.withTenant(async () => 42))).toBe(42);
    await expect(asOrg(ORG_A, () => db.withTenant(async () => { throw new RangeError('x'); }))).rejects.toBeInstanceOf(RangeError);
  });
});

describe('superficie pública', () => {
  it('Database solo expone withTenant, withPlatform, withIdentity, ping y close', () => {
    const publicMethods = Object.getOwnPropertyNames(Database.prototype).filter((n) => n !== 'constructor' && n !== 'run').sort();
    expect(publicMethods).toEqual(['close', 'ping', 'withIdentity', 'withPlatform', 'withTenant']);
    for (const forbidden of ['pool', 'pools', 'client', 'drizzle', 'db', 'query', 'execute', 'connect']) {
      expect(forbidden in Database.prototype).toBe(false);
    }
  });

  it('el barrel de db/ exporta solo la API prevista (nada de pools, guarded-client, auditoría ni migraciones)', () => {
    expect(Object.keys(dbModule).sort()).toEqual(['DB_ROLES', 'Database', 'DatabaseContextMismatchError', 'DbModule', 'LeakedTransactionError', 'identityTable', 'authThrottle', 'disposableDomains', 'emailVerifications', 'signupAttempts', 'passwordResets', 'roles', 'permissions', 'rolePermissions', 'auditLogs', 'platformAudit', 'organizationMembers', 'organizations', 'platformTable', 'sessions', 'tenantTable', 'users'].sort());
  });
});
