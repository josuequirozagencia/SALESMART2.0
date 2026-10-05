// DESCARTABLE — spike Prisma 7 (driver adapter pg): escenarios A↔B
import { PrismaClient, Prisma } from './generated/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';
import { A, B, CONTACT_B, scenario, eq, expectError, sleep, results } from '../shared/harness.ts';
import { writeFileSync } from 'node:fs';
import pg from 'pg';

const mk = (u: string, p: string, max: number) => new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://${u}:${p}@localhost:5432/spike_prisma`, max }) });
const prisma = mk('app_rw', 'rw', 4);
const prisma1 = mk('app_rw', 'rw', 1);
const opts = { maxWait: 20000, timeout: 20000 };

// ÚNICO punto de acceso previsto
const withTenant = <T>(c: PrismaClient, org: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  c.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`; return fn(tx); }, opts);

const t0 = Date.now();
await scenario('S1', 'sin contexto: lectura vacía (falla cerrado)', async () => {
  eq((await prisma.contact.findMany()).length, 0, 'filas sin contexto');
  const m = await expectError(prisma.contact.create({ data: { organizationId: A, name: 'x' } }), /row-level security/, 'insert sin contexto');
  return `0 filas; insert bloqueado (${m})`;
});
await scenario('S2', 'contexto A solo ve datos de A', async () => {
  const r = await withTenant(prisma, A, (tx) => tx.contact.findMany());
  eq(r.map((x) => x.name).sort(), ['Alberto (A)', 'Ana (A)'], 'contactos A'); return '2 filas, todas de A';
});
await scenario('S3', 'A pide por id un contacto de B', async () => {
  const r = await withTenant(prisma, A, (tx) => tx.contact.findUnique({ where: { id: CONTACT_B } }));
  eq(r, null, 'fila'); return 'null';
});
await scenario('S4', 'A intenta UPDATE sobre contacto de B', async () => {
  const r = await withTenant(prisma, A, (tx) => tx.contact.updateMany({ where: { id: CONTACT_B }, data: { name: 'HACKEADO' } }));
  eq(r.count, 0, 'afectadas');
  const m = await expectError(withTenant(prisma, A, (tx) => tx.contact.update({ where: { id: CONTACT_B }, data: { name: 'HACKEADO' } })), /not found|P2025|No record/i, 'update() por id');
  const b = await withTenant(prisma, B, (tx) => tx.contact.findMany()); eq(b[0].name, 'Beto (B)', 'B intacto'); return `updateMany: 0; update(): lanza (${m.slice(0,40)}…); B intacto`;
});
await scenario('S5', 'A intenta DELETE sobre contacto de B', async () => {
  const r = await withTenant(prisma, A, (tx) => tx.contact.deleteMany({ where: { id: CONTACT_B } })); eq(r.count, 0, 'afectadas'); return '0 afectadas';
});
await scenario('S6', 'A intenta INSERT con organization_id de B (WITH CHECK)', async () =>
  expectError(withTenant(prisma, A, (tx) => tx.contact.create({ data: { organizationId: B, name: 'intruso' } })), /row-level security/, 'insert cruzado'));
await scenario('S7', 'SQL crudo dentro de la transacción respeta RLS (incl. OR 1=1)', async () => {
  const r = await withTenant(prisma, A, (tx) => tx.$queryRaw<{ name: string }[]>`SELECT name FROM contacts WHERE 1=1 OR true`);
  eq(r.length, 2, 'filas crudas'); return '2 filas (solo A) aun con OR 1=1';
});
await scenario('S8', 'JOIN/relaciones con RLS', async () => {
  const r = await withTenant(prisma, A, (tx) => tx.deal.findMany({ include: { contact: true } }));
  eq(r.length, 1, 'deals A'); eq(r[0].amount.toString(), '100', 'monto'); return '1 fila (A, 100)';
});
await scenario('S9', 'el contexto NO sobrevive al commit (pool de 1 conexión)', async () => {
  await withTenant(prisma1, A, (tx) => tx.contact.findMany());
  eq((await prisma1.contact.findMany()).length, 0, 'filas tras commit'); return '0 filas tras la transacción en la misma conexión';
});
await scenario('S10', 'A y luego B en la misma conexión: sin fuga', async () => {
  await withTenant(prisma1, A, (tx) => tx.contact.findMany());
  const r = await withTenant(prisma1, B, (tx) => tx.contact.findMany()); eq(r.map((x) => x.name), ['Beto (B)'], 'B'); return 'B ve solo a B';
});
await scenario('S11', '40 transacciones concurrentes A/B intercaladas (pool 4)', async () => {
  const out = await Promise.all(Array.from({ length: 40 }, (_, i) => (async () => {
    const org = i % 2 ? A : B;
    return withTenant(prisma, org, async (tx) => { await sleep(Math.random() * 15); const r = await tx.contact.findMany(); await sleep(Math.random() * 15); return { org, names: r.map((x) => x.name) }; });
  })()));
  for (const o of out) for (const n of o.names) if (!n.includes(o.org === A ? '(A)' : '(B)')) throw new Error('FUGA: ' + n);
  return '40 txs, 0 fugas';
});
await scenario('S12', 'advisory lock xact serializa read-modify-write', async () => {
  const where = { organizationId_key: { organizationId: A, key: 'k' } };
  const run = async (lock: boolean) => {
    await withTenant(prisma, A, (tx) => tx.counter.upsert({ where, create: { organizationId: A, key: 'k', value: 0 }, update: { value: 0 } }));
    await Promise.all(Array.from({ length: 20 }, () => withTenant(prisma, A, async (tx) => {
      if (lock) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${A + ':counter:k'}, 0))`;
      const c = await tx.counter.findUniqueOrThrow({ where }); await sleep(5);
      await tx.counter.update({ where, data: { value: c.value + 1 } });
    })));
    return (await withTenant(prisma, A, (tx) => tx.counter.findUniqueOrThrow({ where }))).value;
  };
  const sin = await run(false), con = await run(true);
  eq(con, 20, 'con lock'); if (sin >= 20) throw new Error('el control sin lock no mostró carrera');
  const p = new pg.Pool({ connectionString: 'postgresql://app_rw:rw@localhost:5432/spike_prisma', max: 1 });
  const left = await p.query(`select count(*)::int n from pg_locks where locktype='advisory'`); await p.end();
  eq(left.rows[0].n, 0, 'locks residuales'); return `sin lock=${sin}/20 (carrera), con lock=20/20; 0 locks residuales tras commit`;
});
await scenario('S13', 'tabla de plataforma: app_rw denegado, app_platform permitido', async () => {
  const m = await expectError(prisma.aiPricing.findMany(), /permission denied/, 'app_rw lee ai_pricing');
  const pp = mk('app_platform', 'platform', 1); const r = await pp.aiPricing.findMany(); await pp.$disconnect(); eq(r.length, 1, 'filas platform'); return `app_rw: ${m}; app_platform: 1 fila`;
});
await scenario('S14', 'PROHIBIDO: SET de sesión (no LOCAL) FILTRA entre peticiones', async () => {
  await prisma1.$executeRaw`SELECT set_config('app.org_id', ${A}, false)`;
  const r = await prisma1.contact.findMany();
  await prisma1.$executeRawUnsafe('RESET app.org_id');
  if (r.length === 0) throw new Error('no demostró fuga'); return `FUGA demostrada: petición sin contexto vio ${r.length} filas de A (por eso se prohíbe)`;
});
await scenario('S15', 'la política no se puede evadir cambiando de rol desde la app', async () => {
  const m = await expectError(prisma.$executeRawUnsafe('SET ROLE app_owner'), /permission denied|must be member/, 'SET ROLE');
  const m2 = await expectError(prisma.$executeRawUnsafe('ALTER TABLE contacts DISABLE ROW LEVEL SECURITY'), /must be owner/, 'ALTER'); return `SET ROLE: ${m}; ALTER: ${m2}`;
});
// Extra Prisma: extensión que inyecta el contexto en CADA operación (patrón documentado por Prisma)
await scenario('S16', 'extensión $extends: contexto automático por operación', async () => {
  const forOrg = (org: string) => prisma.$extends({ query: { $allModels: { async $allOperations({ args, query }) {
    const [, result] = await prisma.$transaction([prisma.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`, query(args) as any]); return result; } } } });
  const a = await forOrg(A).contact.findMany(); eq(a.length, 2, 'A');
  const b = await forOrg(B).contact.findMany(); eq(b.length, 1, 'B');
  const x = await forOrg(A).contact.findUnique({ where: { id: CONTACT_B } }); eq(x, null, 'cruzado');
  return 'cada operación suelta recibe su contexto; pero NO comparte transacción entre operaciones (hay que usar withTenant para unidades atómicas)';
});
const N = 200, t1 = Date.now();
for (let i = 0; i < N; i++) await withTenant(prisma, A, (tx) => tx.contact.findMany());
const t2 = Date.now(); for (let i = 0; i < N; i++) await prisma.contact.findMany();
const perTx = ((t2 - t1) / N).toFixed(2), perBare = ((Date.now() - t2) / N).toFixed(2);
console.log(`LATENCIA con contexto (BEGIN+set_config+query+COMMIT): ${perTx} ms · sin contexto: ${perBare} ms`);
writeFileSync('./results.json', JSON.stringify({ orm: 'prisma', version: '7.10.0 (adapter-pg)', results, perTxMs: perTx, perBareMs: perBare }, null, 2));
console.log(`\nPrisma: ${results.filter((r) => r.ok).length}/${results.length} escenarios OK en ${Date.now() - t0} ms`);
await prisma.$disconnect(); await prisma1.$disconnect();
