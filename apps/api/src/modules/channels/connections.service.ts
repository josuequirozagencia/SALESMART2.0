import { Inject, Injectable } from '@nestjs/common';
import { uuidv7 } from '@sales-smart/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { channelAccounts, Database, queues, whatsappAccounts, type TenantTx } from '../../db';
import { AppError, ConflictError, NotFoundError, ServiceUnavailableError } from '../../errors';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { ChannelRoutesService } from '../organizations';
import { ChannelVault } from './channel-vault.service';
import { MAX_CHANNELS, type CreateChannelDto, type UpdateChannelDto } from './channels.dto';
import { WHATSAPP_PROVIDER, WhatsAppProviderError, type NumberInfo, type WhatsAppProvider } from './whatsapp.port';

type AccountRow = typeof channelAccounts.$inferSelect;
type WhatsAppRow = typeof whatsappAccounts.$inferSelect;

export interface ChannelView {
  id: string;
  provider: 'meta_cloud';
  is_official: boolean;
  name: string;
  status: 'active' | 'disabled';
  /** Cola por defecto: a dónde van las conversaciones nuevas de este número. */
  queue_id: string | null;
  waba_id: string;
  phone_number_id: string;
  display_phone: string | null;
  verified_name: string | null;
  /** Últimos 4 caracteres del token; el valor completo no se puede leer jamás. */
  token_last4: string | null;
  last_check_at: string | null;
  last_error: string | null;
  /** Última vez que Meta avisó de algo de este número (mensaje o estado): sirve para saber si el webhook está llegando. */
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

const AUDIT = 'channel';
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const last4 = (t: string): string | null => (t.length >= 8 ? t.slice(-4) : null);

const view = (a: AccountRow, w: WhatsAppRow): ChannelView => ({
  id: a.id,
  provider: 'meta_cloud',
  is_official: a.isOfficial,
  name: a.name,
  status: a.status as ChannelView['status'],
  queue_id: a.queueId,
  waba_id: w.wabaId,
  phone_number_id: w.phoneNumberId,
  display_phone: w.displayPhone,
  verified_name: w.verifiedName,
  token_last4: a.tokenLast4,
  last_check_at: iso(w.lastCheckAt),
  last_error: w.lastError,
  last_event_at: iso(w.lastEventAt),
  created_at: a.createdAt.toISOString(),
  updated_at: a.updatedAt.toISOString(),
});

/**
 * Conexiones de WhatsApp oficial de una empresa (M5.1, ADR-50). Solo `channels.manage` (lo exige el controlador). Guardar una conexión exige que el proveedor
 * acepte el token para ese número; el token se cifra con la bóveda y no se devuelve nunca. Un número solo puede estar activo en UNA empresa (ruta de identidad).
 */
@Injectable()
export class ConnectionsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    @Inject(ChannelVault) private readonly vault: ChannelVault,
    @Inject(ChannelRoutesService) private readonly routes: ChannelRoutesService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async list(): Promise<{ items: ChannelView[]; vault: { available: boolean } }> {
    const items = await this.db.withTenant(async (tx) => {
      const rows = await tx
        .select({ a: channelAccounts, w: whatsappAccounts })
        .from(channelAccounts)
        .innerJoin(whatsappAccounts, and(eq(whatsappAccounts.organizationId, channelAccounts.organizationId), eq(whatsappAccounts.channelAccountId, channelAccounts.id)))
        .where(and(isNull(channelAccounts.deletedAt), eq(whatsappAccounts.active, true)))
        .orderBy(asc(channelAccounts.createdAt), asc(channelAccounts.id));
      return rows.map((r) => view(r.a, r.w));
    });
    return { items, vault: { available: this.vault.available } };
  }

  async create(input: CreateChannelDto): Promise<ChannelView> {
    this.requireVault();
    const c = TenantContext.current();
    await this.db.withTenant(async (tx) => {
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(channelAccounts).where(isNull(channelAccounts.deletedAt));
      if ((n?.n ?? 0) >= MAX_CHANNELS) throw new ConflictError('CHANNEL_LIMIT', `Se alcanzó el máximo de ${MAX_CHANNELS} conexiones. Desconecta alguna para crear otra`);
      const [dup] = await tx.select({ id: whatsappAccounts.channelAccountId }).from(whatsappAccounts).where(and(eq(whatsappAccounts.phoneNumberId, input.phone_number_id), eq(whatsappAccounts.active, true))).limit(1);
      if (dup) throw this.numberInUse();
      if (input.queue_id) await this.requireQueue(tx, input.queue_id);
    });
    const info = await this.verify(input.access_token, input.phone_number_id);
    const id = uuidv7();
    if (!(await this.routes.claim(input.phone_number_id, c.organizationId, id))) throw this.numberInUse();
    try {
      return await this.db.withTenant(async (tx) => {
        const sealed = this.vault.seal(id, { access_token: input.access_token });
        const [a] = await tx
          .insert(channelAccounts)
          .values({ id, provider: 'meta_cloud', isOfficial: true, name: input.name, queueId: input.queue_id ?? null, credentialsSealed: sealed.sealed, keyVersion: sealed.keyVersion, tokenLast4: last4(input.access_token), createdBy: c.userId ?? null })
          .returning();
        const [w] = await tx
          .insert(whatsappAccounts)
          .values({ channelAccountId: id, wabaId: input.waba_id, phoneNumberId: input.phone_number_id, displayPhone: info.displayPhone, verifiedName: info.verifiedName, lastCheckAt: new Date() })
          .returning();
        await writeAudit(tx, { entityType: AUDIT, entityId: id, newValue: { name: a!.name, provider: 'meta_cloud', waba_id: w!.wabaId, phone_number_id: w!.phoneNumberId, queue_id: a!.queueId }, source: 'manual' });
        return view(a!, w!);
      });
    } catch (e) {
      await this.undoClaim(input.phone_number_id, c.organizationId, e);
      throw this.nameTaken(e) ?? this.numberTaken(e) ?? e;
    }
  }

  async update(id: string, input: UpdateChannelDto): Promise<ChannelView> {
    if (input.access_token !== undefined) this.requireVault();
    const cur = await this.db.withTenant((tx) => this.mustGet(tx, id));
    const info = input.access_token !== undefined ? await this.verify(input.access_token, cur.w.phoneNumberId) : null;
    return this.db
      .withTenant(async (tx) => {
        const now = new Date();
        const { a, w } = await this.mustGet(tx, id, true);
        const set: Partial<typeof channelAccounts.$inferInsert> = {};
        const audits: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        if (input.name !== undefined && input.name !== a.name) {
          set.name = input.name;
          audits.push({ field: 'name', oldValue: a.name, newValue: input.name });
        }
        if (input.status !== undefined && input.status !== a.status) {
          set.status = input.status;
          audits.push({ field: 'status', oldValue: a.status, newValue: input.status });
        }
        if (input.queue_id !== undefined && input.queue_id !== a.queueId) {
          if (input.queue_id !== null) await this.requireQueue(tx, input.queue_id);
          set.queueId = input.queue_id;
          audits.push({ field: 'queue_id', oldValue: a.queueId, newValue: input.queue_id });
        }
        let wa = w;
        if (input.access_token !== undefined && info) {
          const sealed = this.vault.seal(id, { access_token: input.access_token });
          set.credentialsSealed = sealed.sealed;
          set.keyVersion = sealed.keyVersion;
          set.tokenLast4 = last4(input.access_token);
          audits.push({ field: 'token_rotated', oldValue: null, newValue: true });
          wa = (await tx.update(whatsappAccounts).set({ displayPhone: info.displayPhone, verifiedName: info.verifiedName, lastCheckAt: now, lastError: null, updatedAt: now }).where(eq(whatsappAccounts.channelAccountId, id)).returning())[0]!;
        }
        const row = audits.length === 0 ? a : (await tx.update(channelAccounts).set({ ...set, updatedAt: now }).where(eq(channelAccounts.id, id)).returning())[0]!;
        for (const x of audits) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: x.field, oldValue: x.oldValue, newValue: x.newValue, source: 'manual' });
        return view(row, wa);
      })
      .catch((e: unknown) => {
        throw this.nameTaken(e) ?? e;
      });
  }

  /**
   * Vuelve a preguntarle al proveedor por el número (¿el token sigue sirviendo?). Un token rechazado o un número que ya no existe se guardan como el último
   * error de la conexión (no son un fallo de la petición); si el proveedor no responde, es un 503 y no se cambia nada.
   */
  async check(id: string): Promise<ChannelView> {
    const cur = await this.db.withTenant((tx) => this.mustGet(tx, id));
    const secrets = cur.a.credentialsSealed ? this.vault.open(id, cur.a.credentialsSealed) : null;
    if (!secrets?.['access_token']) throw new ConflictError('CHANNEL_CREDENTIALS_UNREADABLE', 'No se pueden leer las credenciales guardadas. Vuelve a pegar el token');
    let info: NumberInfo | null = null;
    let error: string | null = null;
    try {
      info = await this.provider.describeNumber({ accessToken: secrets['access_token'] }, cur.w.phoneNumberId);
    } catch (e) {
      if (!(e instanceof WhatsAppProviderError) || e.code === 'unavailable') throw this.providerDown();
      error = e.code === 'invalid_token' ? 'Meta rechazó el token: genera uno nuevo y pégalo' : 'Meta no encontró este número con el token guardado';
    }
    return this.db.withTenant(async (tx) => {
      const now = new Date();
      const { a, w } = await this.mustGet(tx, id, true);
      const [wa] = await tx
        .update(whatsappAccounts)
        .set(info ? { displayPhone: info.displayPhone, verifiedName: info.verifiedName, lastCheckAt: now, lastError: null, updatedAt: now } : { lastCheckAt: now, lastError: error, updatedAt: now })
        .where(eq(whatsappAccounts.channelAccountId, id))
        .returning();
      if ((w.lastError ?? null) !== (error ?? null)) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'health', oldValue: w.lastError === null ? 'ok' : 'error', newValue: error === null ? 'ok' : 'error', source: 'manual' });
      return view(a, wa!);
    });
  }

  /** Desconecta (borrado lógico) y libera el número para poder conectarlo de nuevo. */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    const c = TenantContext.current();
    const phone = await this.db.withTenant(async (tx) => {
      const { w } = await this.mustGet(tx, id, true);
      const now = new Date();
      await tx.update(channelAccounts).set({ deletedAt: now, updatedAt: now, credentialsSealed: null, keyVersion: null, tokenLast4: null }).where(eq(channelAccounts.id, id));
      await tx.update(whatsappAccounts).set({ active: false, updatedAt: now }).where(eq(whatsappAccounts.channelAccountId, id));
      await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'deleted', oldValue: false, newValue: true, source: 'manual' });
      return w.phoneNumberId;
    });
    // La ruta es de identidad (otro pool): se libera tras confirmar. Si falla queda registrado; el número no se puede reconectar hasta liberarlo.
    await this.routes.release(phone, c.organizationId).catch((e: unknown) => this.log.error({ err: e, channel_id: id }, 'no se pudo liberar la ruta del número'));
    return { id, deleted: true };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** La conexión vigente con su número activo; 404 si no existe (o es de otra empresa: la RLS ya la hizo invisible). */
  private async mustGet(tx: TenantTx, id: string, lock = false): Promise<{ a: AccountRow; w: WhatsAppRow }> {
    const q = tx.select({ a: channelAccounts, w: whatsappAccounts }).from(channelAccounts).innerJoin(whatsappAccounts, and(eq(whatsappAccounts.organizationId, channelAccounts.organizationId), eq(whatsappAccounts.channelAccountId, channelAccounts.id))).where(and(eq(channelAccounts.id, id), isNull(channelAccounts.deletedAt), eq(whatsappAccounts.active, true))).limit(1);
    const [row] = await (lock ? q.for('update', { of: channelAccounts }) : q);
    if (!row) throw new NotFoundError();
    return row;
  }

  private requireVault(): void {
    if (!this.vault.available) throw new ServiceUnavailableError('CHANNEL_VAULT_UNAVAILABLE', 'Por ahora no se pueden guardar conexiones: la plataforma aún no tiene configurado el cifrado de credenciales. Avisa a soporte');
  }

  private async verify(token: string, phoneNumberId: string): Promise<NumberInfo> {
    try {
      return await this.provider.describeNumber({ accessToken: token }, phoneNumberId);
    } catch (e) {
      if (e instanceof WhatsAppProviderError) {
        if (e.code === 'invalid_token') throw new AppError(400, 'CHANNEL_TOKEN_INVALID', 'Meta rechazó el token. Revisa que sea un token permanente con permisos de WhatsApp');
        if (e.code === 'number_not_found') throw new AppError(400, 'CHANNEL_NUMBER_NOT_FOUND', 'Meta no encontró ese número con este token. Revisa el «Phone number ID» y los permisos del token');
      }
      throw this.providerDown();
    }
  }

  private providerDown(): ServiceUnavailableError {
    return new ServiceUnavailableError('CHANNEL_PROVIDER_UNAVAILABLE', 'No pudimos hablar con Meta en este momento. Inténtalo de nuevo en unos minutos');
  }

  private numberInUse(): ConflictError {
    return new ConflictError('CHANNEL_NUMBER_IN_USE', 'Ese número ya está conectado. Un número solo puede estar activo en una conexión');
  }

  /** Falló el alta tras reclamar el número: se libera, salvo que ya hubiera una conexión viva con ese número (entonces la ruta vuelve a ser suya). */
  private async undoClaim(phoneNumberId: string, organizationId: string, cause: unknown): Promise<void> {
    try {
      if (this.numberTaken(cause)) {
        const existing = await this.db.withTenant(async (tx) => {
          const [r] = await tx.select({ id: whatsappAccounts.channelAccountId }).from(whatsappAccounts).where(and(eq(whatsappAccounts.phoneNumberId, phoneNumberId), eq(whatsappAccounts.active, true))).limit(1);
          return r?.id;
        });
        if (existing) await this.routes.claim(phoneNumberId, organizationId, existing);
        return;
      }
      await this.routes.release(phoneNumberId, organizationId);
    } catch (e) {
      this.log.error({ err: e }, 'no se pudo deshacer la reserva del número');
    }
  }

  /** La cola existe en la empresa y no está archivada (la clave foránea compuesta ya impide una de otra empresa). */
  private async requireQueue(tx: TenantTx, id: string): Promise<void> {
    const [q] = await tx.select({ id: queues.id }).from(queues).where(and(eq(queues.id, id), isNull(queues.deletedAt))).limit(1);
    if (!q) throw new AppError(400, 'CHANNEL_QUEUE_NOT_FOUND', 'Ese departamento no existe o está archivado');
  }

  private nameTaken(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'channel_accounts_org_name_uq' ? new ConflictError('CHANNEL_EXISTS', 'Ya existe una conexión con ese nombre') : undefined;
  }

  private numberTaken(e: unknown): ConflictError | undefined {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'whatsapp_accounts_phone_active_uq' ? this.numberInUse() : undefined;
  }
}
