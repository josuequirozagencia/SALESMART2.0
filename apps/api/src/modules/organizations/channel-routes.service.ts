import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { channelRoutes, Database } from '../../db';

export interface ChannelRoute {
  organizationId: string;
  channelAccountId: string;
}

/**
 * Rutas de los números de WhatsApp (M5.1, ADR-50). Es una tabla de IDENTIDAD porque el webhook de Meta llega sin sesión: antes de saber de qué empresa es el
 * mensaje hay que buscar su `phone_number_id`. Un número solo puede estar activo en UNA empresa. Sin DELETE: desconectar desactiva la ruta.
 */
@Injectable()
export class ChannelRoutesService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * Reclama el número para una conexión de una empresa. Falla (false) si lo tiene activo OTRA empresa; si es de la misma empresa o estaba desactivado,
   * lo apunta a la conexión dada. Idempotente.
   */
  async claim(phoneNumberId: string, organizationId: string, channelAccountId: string): Promise<boolean> {
    return this.db.withIdentity(async (tx) => {
      const [cur] = await tx.select().from(channelRoutes).where(eq(channelRoutes.phoneNumberId, phoneNumberId)).for('update').limit(1);
      if (!cur) {
        const inserted = await tx.insert(channelRoutes).values({ phoneNumberId, organizationId, channelAccountId, active: true }).onConflictDoNothing().returning({ id: channelRoutes.phoneNumberId });
        return inserted.length > 0; // dos reclamos simultáneos: gana uno
      }
      if (cur.active && cur.organizationId !== organizationId) return false;
      await tx.update(channelRoutes).set({ organizationId, channelAccountId, active: true, updatedAt: new Date() }).where(eq(channelRoutes.phoneNumberId, phoneNumberId));
      return true;
    });
  }

  /** Desactiva la ruta de un número, solo si pertenece a esa empresa. */
  async release(phoneNumberId: string, organizationId: string): Promise<void> {
    await this.db.withIdentity((tx) =>
      tx.update(channelRoutes).set({ active: false, updatedAt: new Date() }).where(and(eq(channelRoutes.phoneNumberId, phoneNumberId), eq(channelRoutes.organizationId, organizationId))),
    );
  }

  /** La empresa y la conexión de un número activo; null si no existe o está desactivado (no se distingue la causa). */
  async resolve(phoneNumberId: string): Promise<ChannelRoute | null> {
    const [row] = await this.db.withIdentity((tx) => tx.select().from(channelRoutes).where(and(eq(channelRoutes.phoneNumberId, phoneNumberId), eq(channelRoutes.active, true))).limit(1));
    return row ? { organizationId: row.organizationId, channelAccountId: row.channelAccountId } : null;
  }
}
