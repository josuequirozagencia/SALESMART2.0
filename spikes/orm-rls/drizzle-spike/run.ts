// DESCARTABLE — spike Drizzle: escenarios A↔B
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq as deq, sql } from 'drizzle-orm';
import { contacts, deals, counters, aiPricing } from './schema';
import { A, B, CONTACT_B, scenario, eq, expectError, sleep, results } from '../shared/harness';
import { writeFileSync } from 'node:fs';

const url = (u: string, p: string) => `postgresql://${u}:${p}@localhost:5432/${process.env.DB ?? 'spike_drizzle'}`;
const pool = new pg.Pool({ connectionString: url('app_rw', 'rw'), max: 4 });
const db = drizzle(pool);
const pool1 = new pg.Pool({ connectionString: url('app_rw', 'rw'), max: 1 });
const db1 = drizzle(pool1);

// ÚNICO punto de acceso previsto: contexto obligatorio por construcción (por convención de módulo)
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const withTenant = <T>(d: typeof db, org: string, fn: (tx: Tx) => Promise<T>) =>
  d.transaction(async (tx) => { await tx.execute(sql`SELECT set_config('app.org_id', ${org}, true)`); return fn(tx); });

const t0 = Date.now();
await scenario('S1', 'sin contexto: lectura vacía (falla cerrado)', async () => {
  eq((await db.select().from(contacts)).length, 0, 'filas sin contexto');
  const m = await expectError(db.insert(contacts).values({ organizationId: A, name: 'x' }), /row-level security/, 'insert sin contexto');
  return `0 filas; insert bloqueado (${m})`;
});
await scenario('S2', 'contexto A solo ve datos de A', async () => {
  const r = await withTenant(db, A, (tx) => tx.select().from(contacts));
  eq(r.map((x) => x.name).sort(), ['Alberto (A)', 'Ana (A)'], 'contactos A'); return '2 filas, todas de A';
});
await scenario('S3', 'A pide por id un contacto de B', async () => {
  const r = await withTenant(db, A, (tx) => tx.select().from(contacts).where(deq(contacts.id, CONTACT_B)));
  eq(r.length, 0, 'filas'); return '0 filas';
});
await scenario('S4', 'A intenta UPDATE sobre contacto de B', async () => {
  const r = await withTenant(db, A, (tx) => tx.update(contacts).set({ name: 'HACKEADO' }).where(deq(contacts.id, CONTACT_B)).returning());
  eq(r.length, 0, 'afectadas');
  const b = await withTenant(db, B, (tx) => tx.select().from(contacts)); eq(b[0].name, 'Beto (B)', 'B intacto'); return '0 afectadas; B intacto';
});
await scenario('S5', 'A intenta DELETE sobre contacto de B', async () => {
  const r = await withTenant(db, A, (tx) => tx.delete(contacts).where(deq(contacts.id, CONTACT_B)).returning());
  eq(r.length, 0, 'afectadas'); return '0 afectadas';
});
await scenario('S6', 'A intenta INSERT con organization_id de B (WITH CHECK)', async () =>
  expectError(withTenant(db, A, (tx) => tx.insert(contacts).values({ organizationId: B, name: 'intruso' })), /row-level security/, 'insert cruzado'));
await scenario('S7', 'SQL crudo dentro de la transacción respeta RLS (incl. OR 1=1)', async () => {
  const r = await withTenant(db, A, (tx) => tx.execute(sql`SELECT name FROM contacts WHERE 1=1 OR true`));
  eq(r.rows.length, 2, 'filas crudas'); return '2 filas (solo A) aun con OR 1=1';
});
await scenario('S8', 'JOIN entre tablas con RLS', async () => {
  const r = await withTenant(db, A, (tx) => tx.select({ c: contacts.name, a: deals.amount }).from(deals).innerJoin(contacts, deq(deals.contactId, contacts.id)));
  eq(r.length, 1, 'join A'); eq(r[0].a, '100.00', 'monto'); return '1 fila (A, 100.00)';
});
await scenario('S9', 'el contexto NO sobrevive al commit (pool de 1 conexión)', async () => {
  await withTenant(db1, A, (tx) => tx.select().from(contacts));
  eq((await db1.select().from(contacts)).length, 0, 'filas tras commit'); return '0 filas tras la transacción en la misma conexión';
});
await scenario('S10', 'A y luego B en la misma conexión: sin fuga', async () => {
  await withTenant(db1, A, (tx) => tx.select().from(contacts));
  const r = await withTenant(db1, B, (tx) => tx.select().from(contacts)); eq(r.map((x) => x.name), ['Beto (B)'], 'B'); return 'B ve solo a B';
});
await scenario('S11', '40 transacciones concurrentes A/B intercaladas (pool 4)', async () => {
  const jobs = Array.from({ length: 40 }, (_, i) => (async () => {
    const org = i % 2 ? A : B;
    return withTenant(db, org, async (tx) => { await sleep(Math.random() * 15); const r = await tx.select().from(contacts); await sleep(Math.random() * 15); return { org, names: r.map((x) => x.name) }; });
  })());
  const out = await Promise.all(jobs);
  for (const o of out) for (const n of o.names) if (!n.includes(o.org === A ? '(A)' : '(B)')) throw new Error('FUGA: ' + n);
  return '40 txs, 0 fugas';
});
await scenario('S12', 'advisory lock xact serializa read-modify-write', async () => {
  const run = async (lock: boolean) => {
    await withTenant(db, A, (tx) => tx.execute(sql`INSERT INTO counters(organization_id,key,value) VALUES (${A},'k',0) ON CONFLICT (organization_id,key) DO UPDATE SET value=0`));
    await Promise.all(Array.from({ length: 20 }, () => withTenant(db, A, async (tx) => {
      if (lock) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${A + ':counter:k'}, 0))`);
      const [c] = await tx.select().from(counters).where(and(deq(counters.organizationId, A), deq(counters.key, 'k')));
      await sleep(5);
      await tx.update(counters).set({ value: c.value + 1 }).where(and(deq(counters.organizationId, A), deq(counters.key, 'k')));
    })));
    const [c] = await withTenant(db, A, (tx) => tx.select().from(counters).where(deq(counters.key, 'k'))); return c.value;
  };
  const sin = await run(false), con = await run(true);
  eq(con, 20, 'con lock'); if (sin >= 20) throw new Error('el control sin lock no mostró carrera'); 
  const left = await pool.query(`select count(*)::int n from pg_locks where locktype='advisory'`);
  eq(left.rows[0].n, 0, 'locks residuales'); return `sin lock=${sin}/20 (carrera), con lock=20/20; 0 locks residuales tras commit`;
});
await scenario('S13', 'tabla de plataforma: app_rw denegado, app_platform permitido', async () => {
  const m = await expectError(db.select().from(aiPricing), /permission denied/, 'app_rw lee ai_pricing');
  const pp = new pg.Pool({ connectionString: url('app_platform', 'platform'), max: 1 });
  const r = await drizzle(pp).select().from(aiPricing); await pp.end(); eq(r.length, 1, 'filas platform'); return `app_rw: ${m}; app_platform: 1 fila`;
});
await scenario('S14', 'PROHIBIDO: SET de sesión (no LOCAL) FILTRA entre peticiones', async () => {
  await db1.execute(sql`SELECT set_config('app.org_id', ${A}, false)`);   // anti-patrón
  const r = await db1.select().from(contacts);                            // otra "petición" sin contexto
  await db1.execute(sql`RESET app.org_id`);
  if (r.length === 0) throw new Error('no demostró fuga'); return `FUGA demostrada: petición sin contexto vio ${r.length} filas de A (por eso se prohíbe)`;
});
await scenario('S15', 'la política no se puede evadir cambiando de rol desde la app', async () => {
  const m = await expectError(db.execute(sql`SET ROLE app_owner`), /permission denied|must be member/, 'SET ROLE');
  const m2 = await expectError(db.execute(sql`ALTER TABLE contacts DISABLE ROW LEVEL SECURITY`), /must be owner/, 'ALTER'); return `SET ROLE: ${m}; ALTER: ${m2}`;
});
const N = 200, t1 = Date.now();
for (let i = 0; i < N; i++) await withTenant(db, A, (tx) => tx.select().from(contacts));
const t2 = Date.now(); for (let i = 0; i < N; i++) await db.select().from(contacts);
const perTx = ((t2 - t1) / N).toFixed(2), perBare = ((Date.now() - t2) / N).toFixed(2);
console.log(`LATENCIA con contexto (BEGIN+set_config+query+COMMIT): ${perTx} ms · sin contexto: ${perBare} ms`);
writeFileSync('./results.json', JSON.stringify({ orm: 'drizzle', version: '0.45.3 / kit 0.31.11', results, perTxMs: perTx, perBareMs: perBare }, null, 2));
console.log(`\nDrizzle: ${results.filter((r) => r.ok).length}/${results.length} escenarios OK en ${Date.now() - t0} ms`);
await pool.end(); await pool1.end();
