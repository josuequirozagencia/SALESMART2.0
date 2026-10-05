// Canario de conexión: tras cualquier petición (éxito, error, rollback, ataques) la conexión vuelve al pool SIN `app.org_id`.
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { contacts } from '../fixtures/schema';
import { ORG_A, ORG_B } from '../support/constants';
import { asOrg, makeRig } from '../support/harness';

const rig = makeRig({ appMax: 1, platformMax: 1 });
afterAll(() => rig.close());

async function guc(): Promise<string> {
  const c = await rig.appPool.connect(); // pool de 1: es LA conexión que usaron todas las peticiones
  try {
    return ((await c.query(`SELECT current_setting('app.org_id', true) AS v`)).rows[0].v as string | null) ?? '';
  } finally {
    c.release();
  }
}

describe('canario de conexión', () => {
  it('la conexión compartida queda sin contexto tras éxito, error, rollback, consultas cruzadas y ataques a RLS', async () => {
    expect(await guc()).toBe('');
    await asOrg(ORG_A, () => rig.db.withTenant((tx) => tx.select().from(contacts)));
    expect(await guc()).toBe('');
    await asOrg(ORG_B, () => rig.db.withTenant(async (tx) => { await tx.insert(contacts).values({ name: 'tmp' }); throw new Error('rollback'); })).catch(() => undefined);
    expect(await guc()).toBe('');
    await asOrg(ORG_A, () => rig.db.withTenant((tx) => tx.insert(contacts).values({ organizationId: ORG_B, name: 'x' }))).catch(() => undefined); // viola RLS
    expect(await guc()).toBe('');
    await asOrg(ORG_A, () => rig.db.withTenant((tx) => tx.execute(sql`SELECT * FROM contacts WHERE 1=1 OR true`)));
    expect(await guc()).toBe('');
    await asOrg(ORG_A, () => rig.db.withTenant((tx) => tx.execute(sql`SELECT bad syntax here`))).catch(() => undefined); // error de SQL en la tx
    expect(await guc()).toBe('');
    await rig.db.ping();
    expect(await guc()).toBe('');
    // y la conexión sigue siendo utilizable tras errores
    expect((await asOrg(ORG_B, () => rig.db.withTenant((tx) => tx.select().from(contacts)))).map((c) => c.name)).toEqual(['Beto (B)']);
  });

  it('control negativo: el canario SÍ detecta un SET de sesión filtrado (la prueba tiene dientes)', async () => {
    const c = await rig.appPool.connect();
    try {
      await c.query(`SELECT set_config('app.org_id', '${ORG_B}', false)`); // exactamente el patrón P1 prohibido
    } finally {
      c.release();
    }
    expect(await guc()).toBe(ORG_B);
    // y demuestra el riesgo: una consulta SIN contexto vería datos de B
    const c2 = await rig.appPool.connect();
    try {
      expect((await c2.query('SELECT * FROM contacts')).rowCount).toBeGreaterThan(0);
      await c2.query(`RESET app.org_id`);
    } finally {
      c2.release();
    }
    expect(await guc()).toBe('');
  });
});
