import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { contacts, Database, metaEvents, metaSettings, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { APP_CONFIG } from '../../tokens';
import { writeAudit } from '../audit';
import { CredentialVault, VaultOpenError } from '../platform';
import { CAPI_PROVIDER, CapiSendError, type CapiCredentials, type CapiProvider } from './capi.ports';
import type { EventsQuery, SaveSettingsDto } from './meta-settings.dto';

export const DEFAULT_GRACE_MINUTES = 30;
const aadOf = (organizationId: string): string => `meta/${organizationId}`;

export interface MetaSettingsView {
  configured: boolean;
  /** ¿Hay con qué hablar con Meta? (adaptador activo y cifrado disponible en el servidor). Si no, no se puede guardar. */
  available: boolean;
  dataset_id: string | null;
  /** Últimos 4 del token: lo único que se devuelve de él. */
  token_last4: string | null;
  grace_minutes: number;
  test_event_code: string | null;
  enabled: boolean;
  last_error: string | null;
  last_check_at: string | null;
  /** Eventos de la empresa por estado (para el aviso de «hay N fallidos»). */
  counts: Record<string, number>;
}

export interface MetaEventView {
  id: string;
  event_id: string;
  type: string;
  status: string;
  attempts: number;
  contact: { id: string; name: string } | null;
  send_after: string;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
  /** ¿Se puede reintentar desde el panel? Solo los fallidos y los bloqueados que aún no cumplen 7 días (Meta rechaza más viejos). */
  can_retry: boolean;
}

/** Meta no acepta eventos de hace más de 7 días. */
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Conexión de la empresa con la API de Conversiones de Meta (M6.4, ADR-45 #5): dataset y token cifrados con la bóveda (AAD `meta/<empresa>`), ventana de gracia del Purchase, código de
 * «Eventos de prueba» y el panel de eventos (con reintento de los fallidos). El token se comprueba contra Meta ANTES de guardarse y nunca se devuelve ni se registra. La empresa sale
 * SIEMPRE de TenantContext.
 */
@Injectable()
export class MetaSettingsService {
  private readonly vault: CredentialVault | null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) cfg: AppConfig,
    @Inject(CAPI_PROVIDER) private readonly provider: CapiProvider,
  ) {
    this.vault = CredentialVault.fromConfig(cfg.providers.credentialsKeys);
  }

  get available(): boolean {
    return this.provider.kind !== 'none' && this.vault !== null;
  }

  // ------------------------------------------------------------------ lectura

  async get(): Promise<MetaSettingsView> {
    return this.db.withTenant(async (tx) => {
      const [s] = await tx.select().from(metaSettings).limit(1);
      const rows = await tx.select({ status: metaEvents.status, n: count() }).from(metaEvents).groupBy(metaEvents.status);
      return {
        configured: !!s,
        available: this.available,
        dataset_id: s?.datasetId ?? null,
        token_last4: s?.tokenLast4 ?? null,
        grace_minutes: s?.graceMinutes ?? DEFAULT_GRACE_MINUTES,
        test_event_code: s?.testEventCode ?? null,
        enabled: s?.enabled ?? false,
        last_error: s?.lastError ?? null,
        last_check_at: s?.lastCheckAt?.toISOString() ?? null,
        counts: Object.fromEntries(rows.map((r) => [r.status, r.n])),
      };
    });
  }

  /** Para quien arma el Purchase: la ventana de gracia de ESTA empresa (la del contexto), o la de por omisión si aún no configuró nada. Dentro de la transacción de quien llama. */
  async graceMs(tx: TenantTx): Promise<number> {
    const [s] = await tx.select({ g: metaSettings.graceMinutes }).from(metaSettings).limit(1);
    return (s?.g ?? DEFAULT_GRACE_MINUTES) * 60_000;
  }

  /** Para el envío: las credenciales abiertas de la empresa del contexto (null si no hay, está apagada o no se pueden abrir). Nunca se registran. */
  async credentials(tx: TenantTx): Promise<(CapiCredentials & { id: string }) | null> {
    const [s] = await tx.select().from(metaSettings).limit(1);
    if (!s || !s.enabled || !this.vault) return null;
    try {
      const secrets = this.vault.open(s.credentialsSealed, aadOf(s.organizationId));
      const accessToken = secrets['access_token'];
      return accessToken ? { id: s.id, datasetId: s.datasetId, accessToken, testEventCode: s.testEventCode } : null;
    } catch (e) {
      if (e instanceof VaultOpenError) return null;
      throw e;
    }
  }

  // ------------------------------------------------------------------ guardar y comprobar

  /** Guarda dataset, token (si viene) y ajustes. Con token nuevo se comprueba contra Meta ANTES de guardar; si Meta lo rechaza, no se guarda nada (400 con el motivo). */
  async save(input: SaveSettingsDto): Promise<MetaSettingsView> {
    if (!this.available) throw new ServiceUnavailableError('META_UNAVAILABLE', 'Por ahora no se puede conectar con Meta: el servidor no tiene configurado el cifrado de credenciales o el envío a Meta. Avisa a soporte');
    const org = TenantContext.current().organizationId;
    const userId = TenantContext.current().userId ?? null;
    const existing = await this.db.withTenant(async (tx) => (await tx.select({ datasetId: metaSettings.datasetId }).from(metaSettings).limit(1))[0] ?? null);
    const token = input.access_token;
    if (!existing && !token) throw new ValidationError([{ path: 'access_token', code: 'required', message: 'Pega el token de acceso del dataset' }]);
    // Cambiar de dataset exige token nuevo: el viejo es del dataset anterior
    if (existing && input.dataset_id !== existing.datasetId && !token) throw new ValidationError([{ path: 'access_token', code: 'required', message: 'Al cambiar de dataset hay que pegar también su token' }]);

    let sealed: { sealed: string; keyVersion: number } | null = null;
    let verifiedName: string | null = null;
    if (token) {
      try {
        verifiedName = (await this.provider.verify({ datasetId: input.dataset_id, accessToken: token, testEventCode: input.test_event_code })).name;
      } catch (e) {
        throw this.asUserError(e);
      }
      sealed = this.vault!.seal({ access_token: token }, aadOf(org));
    }

    const now = new Date();
    await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(metaSettings).for('update').limit(1);
      const values = {
        datasetId: input.dataset_id,
        graceMinutes: input.grace_minutes,
        testEventCode: input.test_event_code ?? null,
        enabled: input.enabled,
        ...(sealed ? { credentialsSealed: sealed.sealed, keyVersion: sealed.keyVersion, tokenLast4: token!.slice(-4), lastError: null, lastCheckAt: now } : {}),
        updatedAt: now,
      };
      if (cur) {
        await tx.update(metaSettings).set(values).where(eq(metaSettings.id, cur.id));
        const changes: Array<[string, unknown, unknown]> = [
          ['dataset_id', cur.datasetId, input.dataset_id],
          ['grace_minutes', cur.graceMinutes, input.grace_minutes],
          ['test_event_code', cur.testEventCode, input.test_event_code ?? null],
          ['enabled', cur.enabled, input.enabled],
        ];
        for (const [field, before, after] of changes) if (before !== after) await writeAudit(tx, { entityType: 'meta_settings', entityId: cur.id, field, oldValue: before, newValue: after, source: 'manual' });
        if (sealed) await writeAudit(tx, { entityType: 'meta_settings', entityId: cur.id, field: 'access_token', source: 'manual' });
      } else {
        const [row] = await tx
          .insert(metaSettings)
          .values({ ...values, credentialsSealed: sealed!.sealed, keyVersion: sealed!.keyVersion, tokenLast4: token!.slice(-4), createdBy: userId, lastCheckAt: now })
          .returning({ id: metaSettings.id });
        await writeAudit(tx, { entityType: 'meta_settings', entityId: row!.id, newValue: { dataset_id: input.dataset_id, grace_minutes: input.grace_minutes, enabled: input.enabled, dataset_name: verifiedName }, source: 'manual' });
      }
    });
    return this.get();
  }

  /** «Probar conexión»: vuelve a comprobar con Meta el dataset y el token guardados y anota el resultado. */
  async test(): Promise<{ ok: true; dataset_name: string | null }> {
    if (!this.available) throw new ServiceUnavailableError('META_UNAVAILABLE', 'Por ahora no se puede conectar con Meta: el servidor no tiene configurado el cifrado de credenciales o el envío a Meta. Avisa a soporte');
    const creds = await this.db.withTenant(async (tx) => {
      const [s] = await tx.select({ id: metaSettings.id }).from(metaSettings).limit(1);
      if (!s) throw new NotFoundError();
      return this.credentials(tx);
    });
    if (!creds) throw new ConflictError('META_DISABLED', 'La conexión con Meta está apagada o sus credenciales no se pueden leer: guárdalas de nuevo');
    const now = new Date();
    try {
      const { name } = await this.provider.verify(creds);
      await this.db.withTenant((tx) => tx.update(metaSettings).set({ lastError: null, lastCheckAt: now, updatedAt: now }).where(eq(metaSettings.id, creds.id)));
      return { ok: true, dataset_name: name };
    } catch (e) {
      // Lo que se anota en la conexión es el motivo de Meta (seguro por contrato), no el mensaje genérico de validación
      const text = e instanceof CapiSendError ? e.message : 'No se pudo comprobar la conexión con Meta';
      await this.db.withTenant((tx) => tx.update(metaSettings).set({ lastError: text.slice(0, 300), lastCheckAt: now, updatedAt: now }).where(eq(metaSettings.id, creds.id)));
      throw this.asUserError(e);
    }
  }

  /** Anota en la conexión que un envío falló por las credenciales (lo ve el administrador en el panel). */
  async noteSendFailure(tx: TenantTx, settingsId: string, message: string, now: Date): Promise<void> {
    await tx.update(metaSettings).set({ lastError: message.slice(0, 300), lastCheckAt: now, updatedAt: now }).where(eq(metaSettings.id, settingsId));
  }

  async noteSendSuccess(tx: TenantTx, settingsId: string, now: Date): Promise<void> {
    await tx.update(metaSettings).set({ lastError: null, lastCheckAt: now }).where(and(eq(metaSettings.id, settingsId), sql`${metaSettings.lastError} IS NOT NULL`));
  }

  // ------------------------------------------------------------------ panel de eventos

  async events(q: EventsQuery): Promise<{ items: MetaEventView[]; next_cursor: string | null }> {
    const limit = q.limit ?? 30;
    return this.db.withTenant(async (tx) => {
      const conds: SQL[] = [];
      if (q.status) conds.push(eq(metaEvents.status, q.status));
      if (q.type) conds.push(eq(metaEvents.type, q.type));
      const cur = this.decodeCursor(q.cursor);
      if (cur) conds.push(or(lt(metaEvents.createdAt, cur.at), and(eq(metaEvents.createdAt, cur.at), lt(metaEvents.id, cur.id)))!);
      const rows = await tx
        .select({ id: metaEvents.id, eventId: metaEvents.eventId, type: metaEvents.type, status: metaEvents.status, attempts: metaEvents.attempts, contactId: metaEvents.contactId, sendAfter: metaEvents.sendAfter, sentAt: metaEvents.sentAt, lastError: metaEvents.lastError, createdAt: metaEvents.createdAt })
        .from(metaEvents)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(metaEvents.createdAt), desc(metaEvents.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      // Nombres de los contactos en una consulta aparte (evita una unión que el compilador de tipos no resuelve bien)
      const names = new Map<string, string>();
      const ids = [...new Set(page.map((e) => e.contactId))];
      if (ids.length > 0) for (const c of await tx.select({ id: contacts.id, name: contacts.name }).from(contacts).where(inArray(contacts.id, ids))) names.set(c.id, c.name);
      const now = Date.now();
      const items = page.map((e): MetaEventView => ({
        id: e.id,
        event_id: e.eventId,
        type: e.type,
        status: e.status,
        attempts: e.attempts,
        contact: names.has(e.contactId) ? { id: e.contactId, name: names.get(e.contactId)! } : null,
        send_after: e.sendAfter.toISOString(),
        sent_at: e.sentAt?.toISOString() ?? null,
        last_error: e.lastError,
        created_at: e.createdAt.toISOString(),
        can_retry: (e.status === 'failed' || e.status === 'blocked') && now - e.createdAt.getTime() <= MAX_AGE_MS,
      }));
      const last = page.at(-1);
      return { items, next_cursor: rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null };
    });
  }

  /** Vuelve a poner en cola un evento fallido o bloqueado. Los de más de 7 días no: Meta rechazaría el lote entero. */
  async retry(id: string): Promise<MetaEventView> {
    await this.db.withTenant(async (tx) => {
      const [e] = await tx.select().from(metaEvents).where(eq(metaEvents.id, id)).for('update').limit(1);
      if (!e) throw new NotFoundError();
      if (e.status !== 'failed' && e.status !== 'blocked') throw new ConflictError('EVENT_NOT_RETRYABLE', 'Solo se pueden reintentar los eventos fallidos o bloqueados');
      if (Date.now() - e.createdAt.getTime() > MAX_AGE_MS) throw new ConflictError('EVENT_TOO_OLD', 'El evento tiene más de 7 días: Meta ya no lo acepta');
      const now = new Date();
      await tx.update(metaEvents).set({ status: 'pending', attempts: 0, sendAfter: now, lastError: null, updatedAt: now }).where(and(eq(metaEvents.id, id), inArray(metaEvents.status, ['failed', 'blocked'])));
      await writeAudit(tx, { entityType: 'contact', entityId: e.contactId, field: 'meta_event_retry', oldValue: e.status, newValue: { event_id: e.eventId }, source: 'manual' });
    });
    const page = await this.events({ limit: 50 });
    const found = page.items.find((x) => x.id === id);
    if (found) return found;
    return this.db.withTenant(async (tx) => {
      const [e] = await tx.select().from(metaEvents).where(eq(metaEvents.id, id)).limit(1);
      if (!e) throw new NotFoundError();
      return { id: e.id, event_id: e.eventId, type: e.type, status: e.status, attempts: e.attempts, contact: null, send_after: e.sendAfter.toISOString(), sent_at: e.sentAt?.toISOString() ?? null, last_error: e.lastError, created_at: e.createdAt.toISOString(), can_retry: false };
    });
  }

  // ------------------------------------------------------------------ internos

  /** Un fallo del adaptador convertido en algo que se le puede mostrar a la persona (400 si son las credenciales o los datos; 503 si Meta no responde). */
  private asUserError(e: unknown): Error {
    if (e instanceof CapiSendError) {
      if (e.credentials || !e.retryable) return new ValidationError([{ path: 'access_token', code: 'rejected', message: e.message }]);
      return new ServiceUnavailableError('META_UNREACHABLE', 'No se pudo contactar a Meta en este momento. Inténtalo de nuevo en unos minutos');
    }
    return new ServiceUnavailableError('META_UNREACHABLE', 'No se pudo comprobar la conexión con Meta');
  }

  private decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
    if (!raw) return null;
    const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|');
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor no válido' }]);
    return { at, id };
  }
}
