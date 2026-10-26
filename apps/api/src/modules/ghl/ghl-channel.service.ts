import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { channelAccounts, Database, ghlConnections, queues, type TenantTx } from '../../db';
import { NotFoundError, ValidationError } from '../../errors';
import { writeAudit } from '../audit';
import type { ChannelConfigDto } from './ghl.dto';
import type { GhlReplyType } from './ghl.ports';

const NAMES = ['GoHighLevel', 'GoHighLevel (canal)'];
const SETTING_KEY = 'ghl_default_type';
export type GhlConnectionState = 'active' | 'needs_reconnect' | 'disconnected';

export interface GhlChannelView {
  /** ¿Existe el canal? Se crea al conectar. */
  configured: boolean;
  channel_id: string | null;
  /** Cola a la que van las conversaciones nuevas de GoHighLevel; sin cola quedan «sin asignar». */
  queue: { id: string; name: string } | null;
  /** Canal de GHL por el que se responde cuando el aviso no dice por cuál llegó el mensaje. */
  default_type: GhlReplyType | null;
}

/**
 * El canal «GoHighLevel» del Inbox (M7.4, ADR-52): una fila de `channel_accounts` (proveedor `ghl`, una por empresa) para que las conversaciones de GoHighLevel vivan en la misma bandeja, con el
 * mismo reparto, SLA y permisos que las de WhatsApp. No guarda credenciales propias: usa las de `ghl_connections`. Su estado SIGUE al de la conexión: activo solo mientras la conexión esté
 * activa (con el token rechazado o desconectada, el Inbox avisa que no se puede responder en vez de dejar mensajes fallando).
 */
@Injectable()
export class GhlChannelService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Asegura el canal y deja su estado según el de la conexión. Dentro de la transacción de quien llama. Devuelve el id del canal. */
  async sync(tx: TenantTx, state: GhlConnectionState): Promise<string> {
    const status = state === 'active' ? 'active' : 'disabled';
    const [cur] = await tx.select({ id: channelAccounts.id, status: channelAccounts.status }).from(channelAccounts).where(and(eq(channelAccounts.provider, 'ghl'), isNull(channelAccounts.deletedAt))).limit(1);
    if (cur) {
      if (cur.status !== status) await tx.update(channelAccounts).set({ status, updatedAt: new Date() }).where(eq(channelAccounts.id, cur.id));
      return cur.id;
    }
    for (const name of [...NAMES, `GoHighLevel ${Math.random().toString(36).slice(2, 6)}`]) {
      const [row] = await tx.insert(channelAccounts).values({ provider: 'ghl', isOfficial: true, name, status }).onConflictDoNothing().returning({ id: channelAccounts.id });
      if (row) {
        await writeAudit(tx, { entityType: 'channel_account', entityId: row.id, newValue: { provider: 'ghl', name, status }, source: 'ghl' });
        return row.id;
      }
      // Otra transacción lo creó a la vez (índice de uno por empresa): ese es el canal
      const [raced] = await tx.select({ id: channelAccounts.id }).from(channelAccounts).where(and(eq(channelAccounts.provider, 'ghl'), isNull(channelAccounts.deletedAt))).limit(1);
      if (raced) return raced.id;
    }
    throw new Error('no se pudo crear el canal de GoHighLevel');
  }

  /** El canal de GHL de la empresa del contexto (null si aún no se conectó). */
  async current(tx: TenantTx): Promise<{ id: string; status: string; queueId: string | null; defaultType: GhlReplyType | null } | null> {
    const [c] = await tx.select({ id: channelAccounts.id, status: channelAccounts.status, queueId: channelAccounts.queueId, settings: channelAccounts.settings }).from(channelAccounts).where(and(eq(channelAccounts.provider, 'ghl'), isNull(channelAccounts.deletedAt))).limit(1);
    if (!c) return null;
    const raw = c.settings[SETTING_KEY];
    const defaultType = raw === 'SMS' || raw === 'WhatsApp' || raw === 'IG' || raw === 'FB' || raw === 'Live_Chat' ? raw : null;
    return { id: c.id, status: c.status, queueId: c.queueId, defaultType };
  }

  async view(): Promise<GhlChannelView> {
    return this.db.withTenant(async (tx) => {
      const c = await this.current(tx);
      if (!c) return { configured: false, channel_id: null, queue: null, default_type: null };
      let queue: GhlChannelView['queue'] = null;
      if (c.queueId) {
        const [q] = await tx.select({ id: queues.id, name: queues.name }).from(queues).where(eq(queues.id, c.queueId)).limit(1);
        queue = q ?? null;
      }
      return { configured: true, channel_id: c.id, queue, default_type: c.defaultType };
    });
  }

  /** Cola de las conversaciones nuevas y canal por omisión para responder. Exige que GoHighLevel esté conectado (el canal se crea al conectar). */
  async configure(input: ChannelConfigDto): Promise<GhlChannelView> {
    await this.db.withTenant(async (tx) => {
      const [conn] = await tx.select({ status: ghlConnections.status }).from(ghlConnections).limit(1);
      const cur = await this.current(tx);
      if (!conn || !cur) throw new NotFoundError();
      if (input.queue_id) {
        const [q] = await tx.select({ id: queues.id }).from(queues).where(and(eq(queues.id, input.queue_id), isNull(queues.deletedAt))).limit(1);
        if (!q) throw new ValidationError([{ path: 'queue_id', code: 'not_found', message: 'La cola no existe' }]);
      }
      const [row] = await tx.select({ settings: channelAccounts.settings }).from(channelAccounts).where(eq(channelAccounts.id, cur.id)).for('update').limit(1);
      const next = { ...(row?.settings ?? {}) };
      if (input.default_type) next[SETTING_KEY] = input.default_type;
      else delete next[SETTING_KEY];
      await tx.update(channelAccounts).set({ queueId: input.queue_id, settings: next, updatedAt: new Date() }).where(eq(channelAccounts.id, cur.id));
      if (cur.queueId !== input.queue_id) await writeAudit(tx, { entityType: 'ghl_channel', entityId: cur.id, field: 'queue_id', oldValue: cur.queueId, newValue: input.queue_id, source: 'manual' });
      if (cur.defaultType !== input.default_type) await writeAudit(tx, { entityType: 'ghl_channel', entityId: cur.id, field: 'default_type', oldValue: cur.defaultType, newValue: input.default_type, source: 'manual' });
    });
    return this.view();
  }
}
