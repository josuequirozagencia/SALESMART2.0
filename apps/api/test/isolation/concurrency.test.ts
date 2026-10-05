// Concurrencia: ≥200 transacciones, 3 organizaciones, pool pequeño (mucha reutilización de conexiones): cero fugas.
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { contacts } from '../fixtures/schema';
import { ORG_A, ORG_B, ORG_C } from '../support/constants';
import { asOrg, makeRig, sleep } from '../support/harness';

const rig = makeRig({ appMax: 5 });
afterAll(() => rig.close());

describe('concurrencia multiempresa', () => {
  it('240 transacciones intercaladas (3 orgs, pool 5): cada una solo ve y escribe lo suyo', async () => {
    const orgs = [ORG_A, ORG_B, ORG_C];
    const N = 240;
    const written = { [ORG_A]: 0, [ORG_B]: 0, [ORG_C]: 0 } as Record<string, number>;
    const label = (o: string) => (o === ORG_A ? 'A' : o === ORG_B ? 'B' : 'C');
    const leaks: string[] = [];

    await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const org = orgs[Math.floor(Math.random() * 3)]!;
        return asOrg(org, () =>
          rig.db.withTenant(async (tx) => {
            await sleep(Math.random() * 15);
            const before = await tx.select().from(contacts);
            for (const r of before) if (r.organizationId !== org) leaks.push(`lectura: fila de ${r.organizationId} en ${org}`);
            if (i % 2 === 0) {
              await tx.insert(contacts).values({ name: `conc-${label(org)}-${i}` });
              written[org] = (written[org] ?? 0) + 1;
            }
            await sleep(Math.random() * 15);
            const after = await tx.select().from(contacts);
            for (const r of after) if (r.organizationId !== org) leaks.push(`lectura2: fila de ${r.organizationId} en ${org}`);
          }),
        );
      }),
    );
    expect(leaks).toEqual([]);

    // Verificación independiente con superusuario (bypassa RLS): cada fila `conc-X-*` pertenece a la org X
    const admin = new Client({ connectionString: rig.info.adminDbUrl });
    await admin.connect();
    try {
      const rows = (await admin.query(`SELECT organization_id, name FROM contacts WHERE name LIKE 'conc-%'`)).rows as Array<{ organization_id: string; name: string }>;
      for (const r of rows) expect(r.organization_id, r.name).toBe(r.name.split('-')[1] === 'A' ? ORG_A : r.name.split('-')[1] === 'B' ? ORG_B : ORG_C);
      for (const o of orgs) expect(rows.filter((r) => r.organization_id === o).length).toBe(written[o]);
      expect(rows.length).toBe(Object.values(written).reduce((a, b) => a + b, 0));
      expect(rows.length).toBeGreaterThan(80);
      await admin.query(`DELETE FROM contacts WHERE name LIKE 'conc-%'`);
    } finally {
      await admin.end();
    }
    expect(rig.appPool.totalCount).toBeLessThanOrEqual(5);
  });
});
