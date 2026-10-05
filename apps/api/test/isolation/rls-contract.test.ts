// Suite de CONTRATO de aislamiento (ADR-24): se ejecuta contra PostgreSQL real con el rol de aplicación.
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { MissingTenantContextError } from '../../src/tenant';
import { contacts, counters, deals } from '../fixtures/schema';
import { CONTACT_A1, CONTACT_B1, ORG_A, ORG_B } from '../support/constants';
import { asOrg, makeRig, sleep } from '../support/harness';

const rig = makeRig({ appMax: 4 });
const { db } = rig;
afterAll(() => rig.close());

const names = async (org: string) => asOrg(org, () => db.withTenant((tx) => tx.select().from(contacts))).then((r) => r.map((x) => x.name).sort());

describe('RLS — contrato de aislamiento', () => {
  it('S1 sin TenantContext: withTenant lanza y NO abre ninguna conexión', async () => {
    const before = rig.appPool.totalCount;
    await expect(db.withTenant(async (tx) => tx.select().from(contacts))).rejects.toBeInstanceOf(MissingTenantContextError);
    expect(rig.appPool.totalCount).toBe(before);
  });

  it('S1b sin contexto de BD (conexión cruda con el rol de la app): 0 filas y escrituras rechazadas', async () => {
    const rows = await rig.appPool.query('SELECT * FROM contacts');
    expect(rows.rowCount).toBe(0);
    await expect(rig.appPool.query(`INSERT INTO contacts(organization_id, name) VALUES ('${ORG_A}', 'x')`)).rejects.toThrow(/row-level security/);
    await expect(rig.appPool.query(`INSERT INTO contacts(name) VALUES ('x')`)).rejects.toThrow(/null value|row-level security/);
  });

  it('S2 el contexto A solo ve datos de A', async () => {
    expect(await names(ORG_A)).toEqual(['Alberto (A)', 'Ana (A)']);
    expect(await names(ORG_B)).toEqual(['Beto (B)']);
  });

  it('S3 A pide por id un contacto de B → 0 filas', async () => {
    const r = await asOrg(ORG_A, () => db.withTenant((tx) => tx.select().from(contacts).where(eq(contacts.id, CONTACT_B1))));
    expect(r).toHaveLength(0);
  });

  it('S4 A intenta UPDATE sobre un contacto de B → 0 afectadas y B intacto', async () => {
    const r = await asOrg(ORG_A, () => db.withTenant((tx) => tx.update(contacts).set({ name: 'HACKEADO' }).where(eq(contacts.id, CONTACT_B1)).returning()));
    expect(r).toHaveLength(0);
    expect(await names(ORG_B)).toEqual(['Beto (B)']);
  });

  it('S5 A intenta DELETE sobre un contacto de B → 0 afectadas', async () => {
    const r = await asOrg(ORG_A, () => db.withTenant((tx) => tx.delete(contacts).where(eq(contacts.id, CONTACT_B1)).returning()));
    expect(r).toHaveLength(0);
    expect(await names(ORG_B)).toEqual(['Beto (B)']);
  });

  it('S6 A intenta INSERT con organization_id de B → rechazado por WITH CHECK', async () => {
    await expect(asOrg(ORG_A, () => db.withTenant((tx) => tx.insert(contacts).values({ organizationId: ORG_B, name: 'intruso' })))).rejects.toThrow(/row-level security|Failed query/);
  });

  it('S6b A intenta mover una fila propia a B con UPDATE → rechazado por WITH CHECK', async () => {
    await expect(asOrg(ORG_A, () => db.withTenant((tx) => tx.update(contacts).set({ organizationId: ORG_B }).where(eq(contacts.id, CONTACT_A1))))).rejects.toThrow();
    expect(await names(ORG_A)).toEqual(['Alberto (A)', 'Ana (A)']);
  });

  it('S7 SQL crudo dentro de la transacción respeta RLS (incluido OR 1=1)', async () => {
    const r = await asOrg(ORG_A, () => db.withTenant((tx) => tx.execute(sql`SELECT name FROM contacts WHERE 1=1 OR true`)));
    expect(r.rows).toHaveLength(2);
  });

  it('S8 JOIN entre tablas con RLS solo devuelve datos propios', async () => {
    const r = await asOrg(ORG_A, () =>
      db.withTenant((tx) => tx.select({ c: contacts.name, a: deals.amount }).from(deals).innerJoin(contacts, and(eq(deals.contactId, contacts.id), eq(deals.organizationId, contacts.organizationId)))),
    );
    expect(r).toEqual([{ c: 'Ana (A)', a: '100.00' }]);
  });

  it('S9 el contexto NO sobrevive al commit (pool de 1 conexión)', async () => {
    const one = makeRig({ appMax: 1 });
    try {
      await asOrg(ORG_A, () => one.db.withTenant((tx) => tx.select().from(contacts)));
      const c = await one.appPool.connect();
      try {
        expect((await c.query(`SELECT current_setting('app.org_id', true) AS v`)).rows[0].v ?? '').toBe('');
        expect((await c.query('SELECT * FROM contacts')).rowCount).toBe(0);
      } finally {
        c.release();
      }
    } finally {
      await one.close();
    }
  });

  it('S10 A y luego B sobre la MISMA conexión: sin fuga', async () => {
    const one = makeRig({ appMax: 1 });
    try {
      await asOrg(ORG_A, () => one.db.withTenant((tx) => tx.select().from(contacts)));
      const b = await asOrg(ORG_B, () => one.db.withTenant((tx) => tx.select().from(contacts)));
      expect(b.map((x) => x.name)).toEqual(['Beto (B)']);
    } finally {
      await one.close();
    }
  });

  it('S11 el contexto se fija ANTES de cualquier consulta del callback (primera sentencia tras BEGIN)', async () => {
    const r = await asOrg(ORG_A, () => db.withTenant((tx) => tx.execute(sql`SELECT current_setting('app.org_id', true) AS v, app_org() AS o`)));
    expect(r.rows[0]).toEqual({ v: ORG_A, o: ORG_A });
  });

  it('S12 advisory lock de transacción serializa read-modify-write (y sin lock hay carrera)', async () => {
    const run = async (lock: boolean) => {
      await asOrg(ORG_A, () => db.withTenant((tx) => tx.execute(sql`INSERT INTO counters(key, value) VALUES ('k', 0) ON CONFLICT (organization_id, key) DO UPDATE SET value = 0`)));
      await Promise.all(
        Array.from({ length: 20 }, () =>
          asOrg(ORG_A, () =>
            db.withTenant(async (tx) => {
              if (lock) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ORG_A + ':counter:k'}, 0))`);
              const [c] = await tx.select().from(counters).where(eq(counters.key, 'k'));
              await sleep(5);
              await tx.update(counters).set({ value: (c?.value ?? 0) + 1 }).where(eq(counters.key, 'k'));
            }),
          ),
        ),
      );
      const [c] = await asOrg(ORG_A, () => db.withTenant((tx) => tx.select().from(counters).where(eq(counters.key, 'k'))));
      return c?.value;
    };
    expect(await run(true)).toBe(20);
    expect(await run(false)).toBeLessThan(20); // control negativo: demuestra que el lock es lo que serializa
  });

  it('S13 organization_id se rellena desde app_org(): el INSERT no necesita pasar la organización', async () => {
    const [row] = await asOrg(ORG_A, () => db.withTenant((tx) => tx.insert(contacts).values({ name: 'Auto (A)' }).returning()));
    expect(row?.organizationId).toBe(ORG_A);
    expect(await names(ORG_B)).toEqual(['Beto (B)']);
    await asOrg(ORG_A, () => db.withTenant((tx) => tx.delete(contacts).where(eq(contacts.name, 'Auto (A)'))));
  });

  it('S14 FK compuesta: A no puede referenciar un contacto de B desde un deal propio', async () => {
    await expect(
      asOrg(ORG_A, () => db.withTenant((tx) => tx.insert(deals).values({ contactId: CONTACT_B1, amount: '1.00' }))),
    ).rejects.toThrow();
    // control: referencia a un contacto propio sí funciona
    const [d] = await asOrg(ORG_A, () => db.withTenant((tx) => tx.insert(deals).values({ contactId: CONTACT_A1, amount: '2.00' }).returning()));
    expect(d?.organizationId).toBe(ORG_A);
    await asOrg(ORG_A, () => db.withTenant((tx) => tx.delete(deals).where(eq(deals.id, d!.id))));
  });

  it('S15 error dentro de la transacción: rollback total y la conexión queda limpia', async () => {
    await expect(
      asOrg(ORG_A, () =>
        db.withTenant(async (tx) => {
          await tx.insert(contacts).values({ name: 'fantasma' });
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect((await names(ORG_A)).includes('fantasma')).toBe(false);
  });

  it('S16 withTenant anidado reutiliza la transacción (atomicidad) sin consumir otra conexión', async () => {
    const one = makeRig({ appMax: 1 });
    try {
      await expect(
        asOrg(ORG_A, () =>
          one.db.withTenant(async (tx) => {
            await tx.insert(contacts).values({ name: 'anidado' });
            await one.db.withTenant(async (inner) => {
              expect((await inner.select().from(contacts).where(eq(contacts.name, 'anidado'))).length).toBe(1); // ve lo no confirmado
            });
            throw new Error('rollback');
          }),
        ),
      ).rejects.toThrow('rollback');
      expect((await asOrg(ORG_A, () => one.db.withTenant((tx) => tx.select().from(contacts).where(eq(contacts.name, 'anidado'))))).length).toBe(0);
    } finally {
      await one.close();
    }
  });
});
