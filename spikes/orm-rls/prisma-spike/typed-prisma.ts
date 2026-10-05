// DESCARTABLE — ¿se puede exigir el contexto en compilación? (Prisma)
import { PrismaClient, Prisma } from './generated/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';
declare const brand: unique symbol;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: 'x' }) });
export type TenantTx = Prisma.TransactionClient & { readonly [brand]: 'tenant' };
export const withTenant = <T>(org: string, fn: (tx: TenantTx) => Promise<T>) =>
  prisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.org_id', ${org}, true)`; return fn(tx as TenantTx); });
export const listContacts = (tx: TenantTx) => tx.contact.findMany();
export const ok = () => withTenant('x', (tx) => listContacts(tx));
export const bad1 = () => listContacts(prisma as any as Prisma.TransactionClient);   // <- error esperado
export const bad2 = () => prisma.$transaction((tx) => listContacts(tx));              // <- error esperado
