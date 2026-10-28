import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '@sales-smart/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { channelAccounts, Database, qrAccounts, queues, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_CONFIG, APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { QrRoutesService } from '../organizations';
import { PlatformCredentialsReader } from '../platform';
import type { EvolutionConnection } from '../channels';
import { dailyLimit, warmupDay } from './qr-limits';
import { QR_SESSION, QrSessionError, type QrCredentials, type QrSessionProvider } from './qr-session.port';

export const MAX_QR_CHANNELS = 5;
const AUDIT = 'channel';
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export interface QrChannelView {
  id: string;
  provider: 'evolution';
  is_official: false;
  name: string;
  /** `created` sin vincular · `connecting` esperando el QR o reconectando (NO es una caída) · `open` activa · `logged_out` el teléfono cerró la sesión · `closed` caída. */
  state: 'created' | 'connecting' | 'open' | 'logged_out' | 'closed';
  /** Teléfono de la sesión y nombre de su perfil, cuando está vinculada. */
  phone: string | null;
  profile_name: string | null;
  queue_id: string | null;
  connected_at: string | null;
  last_event_at: string | null;
  /** Desde cuándo está caída la sesión (null si está bien). */
  down_since: string | null;
  last_error: string | null;
  /** Calentamiento: día en que va y cuántos mensajes puede enviar hoy. */
  warmup: { day: number; daily_limit: number };
  created_at: string;
}

export interface QrList {
  items: QrChannelView[];
  /** `false`: la plataforma no tiene WhatsApp por QR configurado (el Súper Admin debe guardar la URL y la clave de Evolution) o está apagado. */
  available: boolean;
  limits: { max_channels: number };
}

type Row = { a: typeof channelAccounts.$inferSelect; q: typeof qrAccounts.$inferSelect };

/**
 * Conexiones de WhatsApp por QR de una empresa (M9.6, ADR-54/ADR-31; canal NO OFICIAL). Solo `channels.manage` (lo exige el controlador). La clave de Evolution es de la PLATAFORMA (Proveedores):
 * ni se pide a la empresa ni se devuelve jamás. Cada conexión es una instancia de Evolution con nombre aleatorio y su propio webhook (identificador opaco + token con hash). El estado de la sesión
 * lo mantienen los avisos de Evolution y un latido; un QR sin escanear se agota, así que se pide uno nuevo cuando hace falta.
 */
@Injectable()
export class QrConnectionsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QR_SESSION) private readonly provider: QrSessionProvider,
    @Inject(QrRoutesService) private readonly routes: QrRoutesService,
    @Inject(PlatformCredentialsReader) private readonly platform: PlatformCredentialsReader,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Las credenciales de Evolution que la plataforma tiene en uso; null si no hay (o el QR está apagado). */
  async credentials(): Promise<QrCredentials | null> {
    if (this.cfg.channels.qrProvider === 'none') return null;
    const c = await this.platform.active('whatsapp_qr');
    const baseUrl = c?.values['base_url'];
    const apiKey = c?.values['api_key'];
    return baseUrl && apiKey ? { baseUrl, apiKey } : null;
  }

  private async mustCredentials(): Promise<QrCredentials> {
    if (this.cfg.channels.qrProvider === 'none') throw new ServiceUnavailableError('QR_DISABLED', 'WhatsApp por QR está apagado en este entorno');
    const c = await this.credentials();
    if (!c) throw new ServiceUnavailableError('QR_NOT_CONFIGURED', 'WhatsApp por QR no está configurado: el administrador de la plataforma debe guardar la URL y la clave de Evolution en Proveedores');
    return c;
  }

  private webhookUrl(routeId: string, token: string): string {
    const base = this.cfg.frontend.baseUrl;
    if (!base) throw new ServiceUnavailableError('QR_WEBHOOK_URL', 'Falta configurar la dirección pública de la aplicación (FRONTEND_BASE_URL) para que WhatsApp por QR pueda avisarnos');
    return `${base}/v1/integrations/qr/webhook/${routeId}?token=${encodeURIComponent(token)}`;
  }

  /** Un error del proveedor, traducido a uno nuestro (con un texto que la persona entiende; nunca la clave ni la dirección del servidor). */
  private translate(e: unknown): unknown {
    if (!(e instanceof QrSessionError)) return e;
    if (e.code === 'not_configured') return new ServiceUnavailableError('QR_NOT_CONFIGURED', 'El servidor de WhatsApp por QR rechazó la clave de la plataforma: el administrador de la plataforma debe revisarla en Proveedores');
    if (e.code === 'not_found') return new ConflictError('QR_INSTANCE_MISSING', 'La sesión de WhatsApp por QR ya no existe en el servidor: vuelve a crear la conexión');
    return new ServiceUnavailableError('QR_UNAVAILABLE', 'No pudimos hablar con el servidor de WhatsApp por QR. Inténtalo de nuevo en unos minutos');
  }

  async list(): Promise<QrList> {
    const rows = await this.db.withTenant((tx) => this.rows(tx));
    const now = new Date();
    return { items: rows.map((r) => this.view(r, now)), available: (await this.credentials()) !== null, limits: { max_channels: MAX_QR_CHANNELS } };
  }

  async create(input: { name: string; queue_id?: string | null }): Promise<QrChannelView> {
    const creds = await this.mustCredentials();
    await this.db.withTenant(async (tx) => {
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(channelAccounts).where(and(isNull(channelAccounts.deletedAt), eq(channelAccounts.provider, 'evolution')));
      if ((n?.n ?? 0) >= MAX_QR_CHANNELS) throw new ConflictError('CHANNEL_LIMIT', `Se alcanzó el máximo de ${MAX_QR_CHANNELS} conexiones por QR. Borra alguna para crear otra`);
      if (input.queue_id) await this.requireQueue(tx, input.queue_id);
    });
    const id = uuidv7();
    const instance = `ss-${randomBytes(12).toString('hex')}`; // aleatorio: nunca el nombre de la empresa
    const route = await this.routes.issue(id);
    try {
      await this.provider.createInstance(creds, { instance, webhookUrl: this.webhookUrl(route.id, route.token) });
    } catch (e) {
      await this.routes.revoke(id).catch(() => undefined);
      throw this.translate(e);
    }
    try {
      return await this.db.withTenant(async (tx) => {
        const [a] = await tx.insert(channelAccounts).values({ id, provider: 'evolution', isOfficial: false, name: input.name, queueId: input.queue_id ?? null }).returning();
        const [q] = await tx.insert(qrAccounts).values({ channelAccountId: id, instanceName: instance, state: 'connecting' }).returning();
        await writeAudit(tx, { entityType: AUDIT, entityId: id, newValue: { name: a!.name, provider: 'evolution', official: false, queue_id: a!.queueId }, source: 'manual' });
        return this.view({ a: a!, q: q! }, new Date());
      });
    } catch (e) {
      await this.provider.deleteInstance(creds, instance).catch(() => undefined); // no quedan instancias huérfanas
      await this.routes.revoke(id).catch(() => undefined);
      throw this.nameTaken(e) ?? e;
    }
  }

  async get(id: string): Promise<QrChannelView> {
    const r = await this.db.withTenant((tx) => this.mustGet(tx, id));
    return this.view(r, new Date());
  }

  /** El estado de la sesión AHORA, consultado a Evolution (la pantalla lo pide cada pocos segundos mientras se escanea el QR). */
  async status(id: string): Promise<QrChannelView> {
    const r = await this.db.withTenant((tx) => this.mustGet(tx, id));
    const creds = await this.credentials();
    if (creds) {
      try {
        const state = await this.provider.state(creds, r.q.instanceName);
        await this.db.withTenant((tx) => this.applyState(tx, id, { state, reason: null, phone: null, profileName: null }));
      } catch (e) {
        if (!(e instanceof QrSessionError)) throw e; // si Evolution no contesta se muestra lo último que se sabe
      }
    }
    return this.get(id);
  }

  /** Un QR nuevo para vincular el teléfono (dura ~30 s). Si la instancia ya no existe en Evolution se vuelve a crear. */
  async qr(id: string): Promise<{ qr: string | null; state: QrChannelView['state']; expires_in: number }> {
    const creds = await this.mustCredentials();
    const r = await this.db.withTenant((tx) => this.mustGet(tx, id));
    let res;
    try {
      res = await this.provider.requestQr(creds, r.q.instanceName);
    } catch (e) {
      if (!(e instanceof QrSessionError) || e.code !== 'not_found') throw this.translate(e);
      const route = await this.routes.issue(id); // Evolution perdió la instancia (p. ej. se reinstaló): se crea de nuevo, con un token nuevo
      try {
        await this.provider.createInstance(creds, { instance: r.q.instanceName, webhookUrl: this.webhookUrl(route.id, route.token) });
        res = await this.provider.requestQr(creds, r.q.instanceName);
      } catch (e2) {
        throw this.translate(e2);
      }
    }
    await this.db.withTenant((tx) => this.applyState(tx, id, { state: res.state === 'open' ? 'open' : 'connecting', reason: null, phone: null, profileName: null }));
    return { qr: res.base64, state: res.state === 'open' ? 'open' : 'connecting', expires_in: 30 };
  }

  /** Cierra la sesión de WhatsApp (el teléfono queda desvinculado); la conexión y su historial se conservan para volver a vincular. */
  async disconnect(id: string): Promise<QrChannelView> {
    const creds = await this.mustCredentials();
    const r = await this.db.withTenant((tx) => this.mustGet(tx, id));
    try {
      await this.provider.logout(creds, r.q.instanceName);
    } catch (e) {
      if (!(e instanceof QrSessionError) || e.code !== 'not_found') throw this.translate(e);
    }
    await this.db.withTenant(async (tx) => {
      await this.applyState(tx, id, { state: 'logged_out', reason: 401, phone: null, profileName: null });
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'qr_session', oldValue: r.q.state, newValue: 'logged_out', source: 'manual' });
    });
    return this.get(id);
  }

  async update(id: string, patch: { name?: string; queue_id?: string | null }): Promise<QrChannelView> {
    await this.db
      .withTenant(async (tx) => {
        const r = await this.mustGet(tx, id, true);
        if (patch.queue_id) await this.requireQueue(tx, patch.queue_id);
        const set: Partial<typeof channelAccounts.$inferInsert> = { updatedAt: new Date() };
        if (patch.name !== undefined && patch.name !== r.a.name) {
          set.name = patch.name;
          await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'name', oldValue: r.a.name, newValue: patch.name, source: 'manual' });
        }
        if (patch.queue_id !== undefined && patch.queue_id !== r.a.queueId) {
          set.queueId = patch.queue_id;
          await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'queue_id', oldValue: r.a.queueId, newValue: patch.queue_id, source: 'manual' });
        }
        await tx.update(channelAccounts).set(set).where(eq(channelAccounts.id, id));
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
    return this.get(id);
  }

  /** Borra la conexión: cierra la sesión, borra la instancia de Evolution, corta el webhook y la marca como borrada. Las conversaciones se conservan. */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    const r = await this.db.withTenant((tx) => this.mustGet(tx, id));
    const creds = await this.credentials();
    if (creds) {
      await this.provider.logout(creds, r.q.instanceName).catch(() => undefined);
      try {
        await this.provider.deleteInstance(creds, r.q.instanceName);
      } catch (e) {
        throw this.translate(e); // si Evolution no responde NO se borra aquí: quedaría una sesión abierta sin dueño
      }
    }
    await this.routes.revoke(id);
    await this.db.withTenant(async (tx) => {
      await tx.update(channelAccounts).set({ deletedAt: new Date(), status: 'disabled', updatedAt: new Date() }).where(eq(channelAccounts.id, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, oldValue: { name: r.a.name, provider: 'evolution' }, newValue: null, source: 'manual' });
    });
    return { id, deleted: true };
  }

  // ------------------------------------------------------------------ estado de la sesión (lo usan el webhook y el latido)

  /**
   * Aplica un cambio de estado de la sesión dentro de la transacción de quien llama. `connecting` no es una caída. Al abrirse guarda el teléfono y el perfil, fija la primera conexión (de ahí corre el
   * calentamiento) y limpia el aviso de caída; al caerse anota desde cuándo. Cada paso de «abierta» a «caída» (y de vuelta) queda en la auditoría como acción automática.
   */
  async applyState(tx: TenantTx, channelAccountId: string, c: Pick<EvolutionConnection, 'state' | 'reason' | 'phone' | 'profileName'>, now = new Date()): Promise<void> {
    const [cur] = await tx.select().from(qrAccounts).where(eq(qrAccounts.channelAccountId, channelAccountId)).limit(1).for('update');
    if (!cur) return;
    const down = c.state === 'logged_out' || c.state === 'closed';
    const set: Partial<typeof qrAccounts.$inferInsert> = { state: c.state, lastEventAt: now, updatedAt: now };
    if (c.state === 'open') {
      set.connectedAt = cur.state === 'open' ? cur.connectedAt : now;
      set.firstConnectedAt = cur.firstConnectedAt ?? now;
      set.downSince = null;
      set.lastError = null;
      if (c.phone) set.phoneE164 = c.phone;
      if (c.profileName) set.profileName = c.profileName.slice(0, 100);
    } else if (down) {
      set.downSince = cur.downSince ?? now;
      set.lastError = c.state === 'logged_out' ? 'El teléfono cerró la sesión: escanea un QR nuevo para volver a conectar' : 'La sesión de WhatsApp se cayó';
    } else if (cur.state === 'open' || cur.state === 'created') {
      // `connecting` encima de una sesión abierta suele ser una reconexión corta: se anota, sin alarma
    }
    await tx.update(qrAccounts).set(set).where(eq(qrAccounts.channelAccountId, channelAccountId));
    // Auditoría de los cambios que importan: ponerse en marcha (desde cualquier otro estado) o caerse (desde uno que no estaba caído); `connecting` y los avisos repetidos no dejan rastro
    const wasDown = cur.state === 'logged_out' || cur.state === 'closed';
    if ((c.state === 'open' && cur.state !== 'open') || (down && !wasDown)) {
      await writeAudit(tx, { entityType: AUDIT, entityId: channelAccountId, field: 'qr_session', oldValue: cur.state, newValue: c.state, source: 'automation' });
    }
  }

  // ------------------------------------------------------------------ internos

  private async rows(tx: TenantTx): Promise<Row[]> {
    return tx
      .select({ a: channelAccounts, q: qrAccounts })
      .from(channelAccounts)
      .innerJoin(qrAccounts, and(eq(qrAccounts.organizationId, channelAccounts.organizationId), eq(qrAccounts.channelAccountId, channelAccounts.id)))
      .where(and(isNull(channelAccounts.deletedAt), eq(channelAccounts.provider, 'evolution')))
      .orderBy(asc(channelAccounts.createdAt), asc(channelAccounts.id));
  }

  private async mustGet(tx: TenantTx, id: string, lock = false): Promise<Row> {
    const q = tx
      .select({ a: channelAccounts, q: qrAccounts })
      .from(channelAccounts)
      .innerJoin(qrAccounts, and(eq(qrAccounts.organizationId, channelAccounts.organizationId), eq(qrAccounts.channelAccountId, channelAccounts.id)))
      .where(and(eq(channelAccounts.id, id), isNull(channelAccounts.deletedAt), eq(channelAccounts.provider, 'evolution')))
      .limit(1);
    const [row] = lock ? await q.for('update', { of: channelAccounts }) : await q;
    if (!row) throw new NotFoundError();
    return row;
  }

  private async requireQueue(tx: TenantTx, id: string): Promise<void> {
    const [q] = await tx.select({ id: queues.id }).from(queues).where(and(eq(queues.id, id), isNull(queues.deletedAt))).limit(1);
    if (!q) throw new NotFoundError();
  }

  private view(r: Row, now: Date): QrChannelView {
    return {
      id: r.a.id,
      provider: 'evolution',
      is_official: false,
      name: r.a.name,
      state: r.q.state as QrChannelView['state'],
      phone: r.q.phoneE164,
      profile_name: r.q.profileName,
      queue_id: r.a.queueId,
      connected_at: iso(r.q.connectedAt),
      last_event_at: iso(r.q.lastEventAt),
      down_since: iso(r.q.downSince),
      last_error: r.q.lastError,
      warmup: { day: warmupDay(r.q.firstConnectedAt, now), daily_limit: dailyLimit(r.q.firstConnectedAt, now) },
      created_at: r.a.createdAt.toISOString(),
    };
  }

  private nameTaken(e: unknown): ConflictError | null {
    const err = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
    const c = err.cause ?? err;
    return c.code === '23505' && c.constraint_name === 'channel_accounts_org_name_uq' ? new ConflictError('CHANNEL_NAME_TAKEN', 'Ya tienes una conexión con ese nombre') : null;
  }
}
