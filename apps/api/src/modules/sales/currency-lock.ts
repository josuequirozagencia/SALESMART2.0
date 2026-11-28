import { count } from 'drizzle-orm';
import { sales, type TenantTx } from '../../db';

/** La moneda de la empresa queda fija en cuanto hay una venta (también anulada): los montos guardados quedarían en otra moneda (ADR-51). */
export const hasSales = async (tx: TenantTx): Promise<boolean> => ((await tx.select({ n: count() }).from(sales))[0]?.n ?? 0) > 0;
