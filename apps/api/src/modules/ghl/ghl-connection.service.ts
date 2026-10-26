import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { Database, ghlConnections, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../../errors';
import { TenantContext } from '../../tenant';
import { APP_CONFIG } from '../../tokens';
import { writeAudit } from '../audit';
import { GhlRoutesService } from '../organizations';
import { CredentialVault, VaultOpenError } from '../platform';
import { GhlChannelService } from './ghl-channel.service';
import type { SaveConnectionDto } from './ghl.dto';
import { GHL_PROVIDER, GhlError, type GhlCredentials, type GhlProvider } from './ghl.ports';

const aadOf = (organizationId: string): string => `ghl/${organizationId}`;
/** Ruta pública a la que el Workflow de GHL envía los avisos (la recibe M7.2). */
export const webhookPath = (id: string): string => `/v1/integrations/ghl/webhook/${id}`;

export type GhlStatus = 'active' | 'needs_reconnect' | 'disconnected';

export interface GhlConnectionView {
  configured: boolean;
  /** ¿Hay con qué hablar con GHL? (adaptador activo y cifrado disponible en el servidor). Si no, no se puede guardar. */
  available: boolean;
  auth_type: 'private_token' | 'oauth';
  status: GhlStatus | null;
  location_id: string | null;
  /** Últimos 4 del token: lo único que se devuelve de él. */
  token_last4: string | null;
  last_error: string | null;
  last_check_at: string | null;
  /** Punto de entrada del Workflow de GHL. El secreto NO está aquí: solo se muestra al generarlo o rotarlo. */
  webhook: { configured: boolean; id: string | null; path: string | null; created_at: string | null; rotated_at: string | null; last_used_at: string | null };
}

/**
 * Conexión de la empresa con GoHighLevel (M7.1, ADR-52/ADR-05): Location y token de integración privada, cifrado con la bóveda (AAD `ghl/<empresa>`). El token se comprueba contra GHL
 * ANTES de guardarse y nunca se devuelve ni se registra. Un token rechazado deja la conexión en `needs_reconnect`; desconectar BORRA el token. La empresa sale SIEMPRE de TenantContext.
 */
@Injectable()
export class GhlConnectionService {
  private readonly vault: CredentialVault | null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) cfg: AppConfig,
    @Inject(GHL_PROVIDER) private readonly provider: GhlProvider,
    @Inject(GhlRoutesService) private readonly routes: GhlRoutesService,
    @Inject(GhlChannelService) private readonly channel: GhlChannelService,
  ) {
    this.vault = CredentialVault.fromConfig(cfg.providers.credentialsKeys);
  }

  get available(): boolean {
    return this.provider.kind !== 'none' && this.vault !== null;
  }

  // ------------------------------------------------------------------ lectura

  async get(): Promise<GhlConnectionView> {
    const row = await this.db.withTenant(async (tx) => (await tx.select().from(ghlConnections).limit(1))[0] ?? null);
    // La ruta del webhook es de identidad (otro pool): se lee fuera de la transacción de negocio
    const hook = await this.routes.status();
    return {
      configured: !!row,
      available: this.available,
      auth_type: (row?.authType as 'private_token' | 'oauth' | undefined) ?? 'private_token',
      status: (row?.status as GhlStatus | undefined) ?? null,
      location_id: row?.locationId ?? null,
      token_last4: row?.tokenLast4 ?? null,
      last_error: row?.lastError ?? null,
      last_check_at: row?.lastCheckAt?.toISOString() ?? null,
      webhook: { configured: hook.configured, id: hook.id, path: hook.id ? webhookPath(hook.id) : null, created_at: hook.created_at, rotated_at: hook.rotated_at, last_used_at: hook.last_used_at },
    };
  }

  /** Para quien hable con GHL (M7.2 en adelante): las credenciales abiertas de la empresa del contexto, solo si la conexión está activa. Nunca se registran. */
  async credentials(tx: TenantTx): Promise<(GhlCredentials & { id: string }) | null> {
    const [c] = await tx.select().from(ghlConnections).limit(1);
    if (!c || c.status !== 'active' || !c.credentialsSealed || !this.vault) return null;
    try {
      const accessToken = this.vault.open(c.credentialsSealed, aadOf(c.organizationId))['access_token'];
      return accessToken ? { id: c.id, locationId: c.locationId, accessToken } : null;
    } catch (e) {
      if (e instanceof VaultOpenError) return null;
      throw e;
    }
  }

  // ------------------------------------------------------------------ guardar, comprobar, desconectar

  /** Guarda Location y token. Con token nuevo se comprueba contra GHL ANTES de guardar; si GHL lo rechaza, no se guarda nada (400 con el motivo). */
  async save(input: SaveConnectionDto): Promise<GhlConnectionView> {
    this.requireAvailable();
    const org = TenantContext.current().organizationId;
    const userId = TenantContext.current().userId ?? null;
    const existing = await this.db.withTenant(async (tx) => (await tx.select({ locationId: ghlConnections.locationId, status: ghlConnections.status }).from(ghlConnections).limit(1))[0] ?? null);
    const token = input.access_token;
    // Sin token guardado que sirva (primera vez, desconectada o rechazada) o con otra Location, hay que pegar el token
    const needsToken = !existing || existing.status !== 'active' || input.location_id !== existing.locationId;
    if (needsToken && !token) {
      const why = !existing ? 'Pega el token de la integración privada' : existing.status !== 'active' ? 'El token guardado ya no sirve: pega uno nuevo' : 'Al cambiar de Location hay que pegar también su token';
      throw new ValidationError([{ path: 'access_token', code: 'required', message: why }]);
    }

    let sealed: { sealed: string; keyVersion: number } | null = null;
    if (token) {
      try {
        await this.provider.verify({ locationId: input.location_id, accessToken: token });
      } catch (e) {
        throw this.asUserError(e);
      }
      sealed = this.vault!.seal({ access_token: token }, aadOf(org));
    }

    const now = new Date();
    await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(ghlConnections).for('update').limit(1);
      if (cur) {
        await tx
          .update(ghlConnections)
          .set({
            locationId: input.location_id,
            ...(sealed ? { credentialsSealed: sealed.sealed, keyVersion: sealed.keyVersion, tokenLast4: token!.slice(-4), status: 'active', lastError: null, lastCheckAt: now } : {}),
            updatedAt: now,
          })
          .where(eq(ghlConnections.id, cur.id));
        if (cur.locationId !== input.location_id) await writeAudit(tx, { entityType: 'ghl_connection', entityId: cur.id, field: 'location_id', oldValue: cur.locationId, newValue: input.location_id, source: 'manual' });
        if (sealed) {
          await writeAudit(tx, { entityType: 'ghl_connection', entityId: cur.id, field: 'access_token', source: 'manual' });
          if (cur.status !== 'active') await writeAudit(tx, { entityType: 'ghl_connection', entityId: cur.id, field: 'status', oldValue: cur.status, newValue: 'active', source: 'manual' });
        }
      } else {
        const [row] = await tx
          .insert(ghlConnections)
          .values({ locationId: input.location_id, credentialsSealed: sealed!.sealed, keyVersion: sealed!.keyVersion, tokenLast4: token!.slice(-4), status: 'active', createdBy: userId, lastCheckAt: now })
          .returning({ id: ghlConnections.id });
        await writeAudit(tx, { entityType: 'ghl_connection', entityId: row!.id, newValue: { location_id: input.location_id, auth_type: 'private_token', status: 'active' }, source: 'manual' });
      }
      // El canal «GoHighLevel» del Inbox (M7.4) sigue al estado de la conexión
      await this.channel.sync(tx, sealed || !cur ? 'active' : (cur.status as GhlStatus));
    });
    return this.get();
  }

  /**
   * «Probar»: vuelve a comprobar con GHL el token guardado. Si GHL lo rechaza, la conexión pasa a `needs_reconnect`; si GHL no responde ahora, solo se anota el aviso (no es culpa del
   * token) y la conexión sigue como estaba. Si estaba en `needs_reconnect` y ahora funciona, vuelve a `active`.
   */
  async test(): Promise<{ ok: true; location_name: string | null }> {
    this.requireAvailable();
    const state = await this.db.withTenant(async (tx) => {
      const [c] = await tx.select({ id: ghlConnections.id, status: ghlConnections.status, sealed: ghlConnections.credentialsSealed, locationId: ghlConnections.locationId, organizationId: ghlConnections.organizationId }).from(ghlConnections).limit(1);
      if (!c) throw new NotFoundError();
      return c;
    });
    if (state.status === 'disconnected' || !state.sealed) throw new ConflictError('GHL_DISCONNECTED', 'La conexión con GoHighLevel está desconectada: conéctala de nuevo con un token');
    let creds: GhlCredentials | null = null;
    try {
      const accessToken = this.vault!.open(state.sealed, aadOf(state.organizationId))['access_token'];
      creds = accessToken ? { locationId: state.locationId, accessToken } : null;
    } catch (e) {
      if (!(e instanceof VaultOpenError)) throw e;
    }
    if (!creds) {
      await this.markStatus(state.id, state.status as GhlStatus, 'needs_reconnect', 'El token guardado no se puede leer: pega uno nuevo');
      throw new ConflictError('GHL_TOKEN_UNREADABLE', 'El token guardado no se puede leer: pega uno nuevo');
    }
    try {
      const { name } = await this.provider.verify(creds);
      await this.markStatus(state.id, state.status as GhlStatus, 'active', null);
      return { ok: true, location_name: name };
    } catch (e) {
      const text = e instanceof GhlError ? e.message : 'No se pudo comprobar la conexión con GoHighLevel';
      await this.markStatus(state.id, state.status as GhlStatus, e instanceof GhlError && e.credentials ? 'needs_reconnect' : (state.status as GhlStatus), text);
      throw this.asUserError(e);
    }
  }

  /** Desconecta: BORRA el token cifrado y deja el estado en `disconnected`. La Location se conserva para reconectar más fácil. */
  async disconnect(): Promise<GhlConnectionView> {
    await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(ghlConnections).for('update').limit(1);
      if (!cur) throw new NotFoundError();
      if (cur.status === 'disconnected') return;
      await tx.update(ghlConnections).set({ status: 'disconnected', credentialsSealed: null, keyVersion: null, tokenLast4: null, lastError: null, updatedAt: new Date() }).where(eq(ghlConnections.id, cur.id));
      await writeAudit(tx, { entityType: 'ghl_connection', entityId: cur.id, field: 'status', oldValue: cur.status, newValue: 'disconnected', source: 'manual' });
      await writeAudit(tx, { entityType: 'ghl_connection', entityId: cur.id, field: 'access_token', source: 'manual' });
      await this.channel.sync(tx, 'disconnected');
    });
    return this.get();
  }

  /** Crea el punto de entrada del Workflow o ROTA su secreto (el anterior deja de servir). El secreto en claro se devuelve esta única vez. */
  async issueWebhookSecret(): Promise<{ id: string; secret: string; rotated: boolean; path: string }> {
    const r = await this.routes.issue();
    return { ...r, path: webhookPath(r.id) };
  }

  /** Anota el resultado de una llamada hecha por otro servicio (M7.2 en adelante): un rechazo de credenciales deja la conexión en `needs_reconnect`. */
  async noteCallResult(tx: TenantTx, connectionId: string, outcome: { ok: true } | { ok: false; message: string; credentials: boolean }, now: Date): Promise<void> {
    if (outcome.ok) {
      await tx.update(ghlConnections).set({ lastError: null, lastCheckAt: now, updatedAt: now }).where(eq(ghlConnections.id, connectionId));
      return;
    }
    const [before] = await tx.select({ status: ghlConnections.status }).from(ghlConnections).where(eq(ghlConnections.id, connectionId)).limit(1);
    await tx
      .update(ghlConnections)
      .set({ lastError: outcome.message.slice(0, 300), lastCheckAt: now, updatedAt: now, ...(outcome.credentials ? { status: 'needs_reconnect' } : {}) })
      .where(eq(ghlConnections.id, connectionId));
    if (outcome.credentials) await this.channel.sync(tx, 'needs_reconnect');
    if (outcome.credentials && before && before.status !== 'needs_reconnect') await writeAudit(tx, { entityType: 'ghl_connection', entityId: connectionId, field: 'status', oldValue: before.status, newValue: 'needs_reconnect', source: 'ghl' });
  }

  /** GHL rechazó el token en una llamada hecha por otro servicio (el envío de un mensaje del Inbox): la conexión pide reconexión. */
  async rejectedByProvider(message: string): Promise<void> {
    await this.db.withTenant(async (tx) => {
      const [c] = await tx.select({ id: ghlConnections.id, status: ghlConnections.status }).from(ghlConnections).limit(1);
      if (!c || c.status !== 'active') return;
      await this.noteCallResult(tx, c.id, { ok: false, message, credentials: true }, new Date());
    });
  }

  // ------------------------------------------------------------------ interno

  private async markStatus(id: string, before: GhlStatus, after: GhlStatus, error: string | null): Promise<void> {
    const now = new Date();
    await this.db.withTenant(async (tx) => {
      await tx.update(ghlConnections).set({ status: after, lastError: error ? error.slice(0, 300) : null, lastCheckAt: now, updatedAt: now }).where(eq(ghlConnections.id, id));
      if (before !== after) await writeAudit(tx, { entityType: 'ghl_connection', entityId: id, field: 'status', oldValue: before, newValue: after, source: 'manual' });
      await this.channel.sync(tx, after);
    });
  }

  private requireAvailable(): void {
    if (!this.available) throw new ServiceUnavailableError('GHL_UNAVAILABLE', 'Por ahora no se puede conectar con GoHighLevel: el servidor no tiene configurado el cifrado de credenciales o el adaptador. Avisa a soporte');
  }

  private asUserError(e: unknown): Error {
    if (e instanceof GhlError) {
      if (e.credentials || !e.retryable) return new ValidationError([{ path: 'access_token', code: 'rejected', message: e.message }]);
      return new ServiceUnavailableError('GHL_UNREACHABLE', 'No se pudo contactar a GoHighLevel en este momento. Inténtalo de nuevo en unos minutos');
    }
    return new ServiceUnavailableError('GHL_UNREACHABLE', 'No se pudo comprobar la conexión con GoHighLevel');
  }
}
