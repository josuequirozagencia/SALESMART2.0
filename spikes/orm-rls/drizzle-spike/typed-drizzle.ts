// DESCARTABLE — ¿se puede exigir el contexto en compilación? (Drizzle)
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { contacts } from './schema';
declare const brand: unique symbol;
const db = drizzle(new pg.Pool());
type RawTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type TenantTx = RawTx & { readonly [brand]: 'tenant' };
export const withTenant = <T>(org: string, fn: (tx: TenantTx) => Promise<T>) =>
  db.transaction(async (tx) => { await tx.execute(sql`SELECT set_config('app.org_id', ${org}, true)`); return fn(tx as TenantTx); });
// Repositorio: SOLO acepta TenantTx
export const listContacts = (tx: TenantTx) => tx.select().from(contacts);
// OK:
export const ok = () => withTenant('x', (tx) => listContacts(tx));
// DEBE FALLAR EN COMPILACIÓN (cliente crudo / transacción cruda):
export const bad1 = () => listContacts(db as any as RawTx);   // <- error esperado
export const bad2 = () => db.transaction((tx) => listContacts(tx)); // <- error esperado
