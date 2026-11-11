import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { calendarConnections, Database } from '../../db';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../../errors';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_CONFIG, APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { OrgDirectoryService } from '../organizations';
import { CredentialVault, PlatformCredentialsReader, VaultOpenError } from '../platform';
import { CALENDAR_PROVIDER, CalendarError, MODE_SCOPES, type CalendarMode, type CalendarProvider, type OAuthClient } from './calendar.ports';
import { deriveKey, maskEmail, newNonce, pkceFor, signState, STATE_TTL_MS, verifyState } from './oauth-state';

/** El servicio de la plataforma donde el Súper Admin carga la aplicación de Google (Proveedores › Calendario › Google). */
export const CALENDAR_SERVICE = 'calendar';
const aadOf = (organizationId: string): string => `gcal/${organizationId}`;
/** Ruta pública a la que Google devuelve a la persona (se registra TAL CUAL en la consola de Google Cloud). */
export const CALLBACK_PATH = '/v1/integrations/google-calendar/callback';
/** Pantalla de la web a la que se vuelve después (Configuración › Google Calendar). */
const RETURN_PATH = '/settings/calendar';

export type CalendarStatus = 'pending_calendar' | 'connected' | 'needs_reconnect' | 'disconnected';
export type CalendarOutcome = 'connected' | 'pick' | 'denied' | 'invalid' | 'scopes' | 'unavailable' | 'api' | 'error';
export type Unavailable = 'provider' | 'encryption' | 'base_url' | 'platform_credentials';

export interface CalendarConnectionView {
  configured: boolean;
  /** ¿Se puede conectar ahora? Si no, `unavailable_reason` dice qué falta (y a quién avisar). */
  available: boolean;
  unavailable_reason: Unavailable | null;
  status: CalendarStatus | null;
  mode: CalendarMode | null;
  calendar_name: string | null;
  /** Correo de la cuenta de Google, ENMASCARADO. */
  account: string | null;
  scopes: string[];
  last_error: string | null;
  connected_at: string | null;
}

export interface CalendarChoice {
  id: string;
  name: string;
  primary: boolean;
}

/**
 * Conexión de la empresa con Google Calendar (v11 Pista G, 67a, ADR-67). La aplicación de Google (ID y secreto) es de la PLATAFORMA; la autorización de cada empresa se guarda como refresh token
 * cifrado con la bóveda (AAD `gcal/<empresa>`) y jamás se devuelve. Flujo OAuth de aplicación web con PKCE y `state` firmado sin tablas (ver `oauth-state.ts`). Dos modos: `own` (Sales Smart crea
 * su propio calendario y solo pide alcances NO sensibles) y `existing` (la persona elige uno que ya tiene). La empresa sale SIEMPRE de TenantContext, salvo en el callback, donde sale del `state`
 * firmado. Los eventos llegan en 67b.
 */
@Injectable()
export class CalendarConnectionService {
  private readonly vault: CredentialVault | null;
  private readonly stateKey: Buffer | null;
  private readonly pkceKey: Buffer | null;
  private readonly redirectUri: string | null;
  private readonly returnBase: string | null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) cfg: AppConfig,
    @Inject(CALENDAR_PROVIDER) private readonly provider: CalendarProvider,
    @Inject(PlatformCredentialsReader) private readonly platform: PlatformCredentialsReader,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {
    this.vault = CredentialVault.fromConfig(cfg.providers.credentialsKeys);
    const master = cfg.providers.credentialsKeys?.current.key;
    this.stateKey = master ? deriveKey(master, 'gcal-oauth-state/v1') : null;
    this.pkceKey = master ? deriveKey(master, 'gcal-oauth-pkce/v1') : null;
    const base = cfg.frontend.baseUrl;
    this.redirectUri = base ? `${new URL(base).origin}${CALLBACK_PATH}` : null;
    this.returnBase = base ? `${base}${RETURN_PATH}` : null;
  }

  // ------------------------------------------------------------------ lectura

  async get(): Promise<CalendarConnectionView> {
    const row = await this.db.withTenant(async (tx) => (await tx.select().from(calendarConnections).limit(1))[0] ?? null);
    const reason = await this.unavailableReason();
    return {
      configured: !!row && row.status !== 'disconnected',
      available: reason === null,
      unavailable_reason: reason,
      status: (row?.status as CalendarStatus | undefined) ?? null,
      mode: (row?.mode as CalendarMode | undefined) ?? null,
      calendar_name: row?.calendarName ?? null,
      account: row?.accountMasked ?? null,
      scopes: row?.scopes ? row.scopes.split(' ').filter(Boolean) : [],
      last_error: row?.lastError ?? null,
      connected_at: row?.connectedAt?.toISOString() ?? null,
    };
  }

  // ------------------------------------------------------------------ conectar

  /** Arma la dirección de Google a la que hay que mandar a la persona. La web hace `location = url`. */
  async start(mode: CalendarMode): Promise<{ url: string }> {
    const reason = await this.unavailableReason();
    if (reason !== null) throw this.unavailable(reason);
    const client = (await this.client())!;
    const { organizationId, userId } = TenantContext.current();
    if (!userId) throw new NotFoundError();
    const nonce = newNonce();
    const state = signState(this.stateKey!, { o: organizationId, u: userId, m: mode, n: nonce, e: Date.now() + STATE_TTL_MS });
    const url = this.provider.authorizeUrl({ client, redirectUri: this.redirectUri!, scopes: MODE_SCOPES[mode], state, codeChallenge: pkceFor(this.pkceKey!, nonce).challenge });
    return { url };
  }

  /**
   * El regreso de Google (ruta PÚBLICA). Valida el `state` ANTES de hacer nada y NUNCA lanza: siempre responde con a dónde mandar a la persona (la pantalla de Conexiones con un resultado, sin
   * detalles). El código y el estado no se registran.
   */
  async callback(q: { code?: string | undefined; state?: string | undefined; error?: string | undefined }): Promise<string> {
    const outcome = await this.handleCallback(q).catch((e: unknown): CalendarOutcome => {
      this.log.error({ err: e instanceof Error ? e.name : 'desconocido', why: 'excepcion_al_guardar' }, 'falló el regreso de Google Calendar');
      return 'error';
    });
    return this.returnUrl(outcome);
  }

  private async handleCallback(q: { code?: string | undefined; state?: string | undefined; error?: string | undefined }): Promise<CalendarOutcome> {
    if (!this.stateKey || !this.pkceKey || !this.vault) return this.end('unavailable', 'sin_cifrado');
    const st = q.state ? verifyState(this.stateKey, q.state) : null;
    if (!st) return this.end('invalid', q.state ? 'state_invalido_o_vencido' : 'sin_state');
    if (q.error) return this.end('denied', 'google_devolvio_error'); // la persona canceló o rechazó en Google: no hay nada que guardar
    if (!q.code || q.code.length > 2048) return this.end('invalid', 'sin_codigo');
    const client = await this.client();
    if (!client || !this.redirectUri) return this.end('unavailable', 'sin_credenciales_de_plataforma');
    let tokens;
    try {
      tokens = await this.provider.exchangeCode({ client, redirectUri: this.redirectUri, code: q.code, codeVerifier: pkceFor(this.pkceKey, st.n).verifier });
    } catch (e) {
      if (e instanceof CalendarError && !e.credentials && !e.retryable) return this.end('unavailable', 'canje_cliente_oauth_mal_configurado');
      if (e instanceof CalendarError && e.credentials) return this.end('denied', 'canje_rechazado_por_google');
      return this.end('error', 'canje_google_no_respondio');
    }
    // La persona pudo desmarcar permisos en la pantalla de Google: sin TODOS los pedidos no sirve (y no dejamos una autorización a medias)
    if (!MODE_SCOPES[st.m].every((s) => tokens.scopes.includes(s))) {
      await this.provider.revoke({ token: tokens.refreshToken }).catch(() => undefined);
      return this.end('scopes', 'permisos_incompletos');
    }
    return TenantContext.run({ organizationId: st.o, userId: st.u }, () => this.store(st.m, tokens.refreshToken, tokens.accessToken, tokens.scopes, st.u));
  }

  /** Deja constancia del resultado en el registro estructurado (sin códigos, tokens ni datos de la cuenta): el motivo que ve el servidor, para poder diagnosticar. */
  private end(outcome: CalendarOutcome, why: string): CalendarOutcome {
    const fields = { outcome, why };
    if (outcome === 'connected' || outcome === 'pick') this.log.info(fields, 'regreso de Google Calendar');
    else this.log.warn(fields, 'regreso de Google Calendar');
    return outcome;
  }

  /** Guarda la autorización: en `own` crea el calendario propio y queda conectada; en `existing` queda esperando que se elija uno. */
  private async store(mode: CalendarMode, refreshToken: string, accessToken: string, scopes: string[], userId: string): Promise<CalendarOutcome> {
    const org = TenantContext.current().organizationId;
    const email = await this.provider.accountEmail({ accessToken }).catch(() => null);
    const accountMasked = email ? maskEmail(email) : null;
    let calendar: { id: string; name: string } | null = null;
    if (mode === 'own') {
      const [orgName, dir] = await Promise.all([this.directory.organizationName(), this.directory.current()]);
      try {
        calendar = await this.provider.createCalendar({ accessToken, name: `Sales Smart · ${orgName}`.slice(0, 200), timeZone: dir.timeZone });
      } catch (e) {
        await this.provider.revoke({ token: refreshToken }).catch(() => undefined);
        if (e instanceof CalendarError && e.kind === 'api_disabled') return this.end('api', 'api_de_calendar_no_habilitada');
        if (e instanceof CalendarError && e.credentials) return this.end('scopes', 'crear_calendario_sin_permiso');
        return this.end('error', e instanceof CalendarError && e.retryable ? 'crear_calendario_google_no_respondio' : 'crear_calendario_rechazado');
      }
    }
    const sealed = this.vault!.seal({ refresh_token: refreshToken }, aadOf(org));
    const now = new Date();
    const previous = await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(calendarConnections).for('update').limit(1);
      const values = {
        mode,
        status: mode === 'own' ? 'connected' : 'pending_calendar',
        credentialsSealed: sealed.sealed,
        keyVersion: sealed.keyVersion,
        calendarId: calendar?.id ?? null,
        calendarName: calendar?.name ?? null,
        accountMasked,
        scopes: scopes.join(' '),
        lastError: null,
        lastCheckAt: now,
        connectedBy: userId,
        connectedAt: mode === 'own' ? now : null,
        updatedAt: now,
      };
      if (cur) {
        await tx.update(calendarConnections).set(values).where(eq(calendarConnections.id, cur.id));
        await writeAudit(tx, { entityType: 'calendar_connection', entityId: cur.id, field: 'status', oldValue: cur.status, newValue: values.status, source: 'manual' });
        return cur;
      }
      const [row] = await tx.insert(calendarConnections).values(values).returning({ id: calendarConnections.id });
      await writeAudit(tx, { entityType: 'calendar_connection', entityId: row!.id, newValue: { mode, status: values.status }, source: 'manual' });
      return null;
    });
    // Si había otra autorización guardada, la anterior ya no sirve: se revoca en Google (sin bloquear ni fallar)
    if (previous?.credentialsSealed) {
      const old = this.openRefreshToken(previous.credentialsSealed, org);
      if (old && old !== refreshToken) await this.provider.revoke({ token: old }).catch(() => undefined);
    }
    return mode === 'own' ? this.end('connected', 'calendario_propio_creado') : this.end('pick', 'falta_elegir_calendario');
  }

  // ------------------------------------------------------------------ elegir calendario (modo existing)

  /** Los calendarios de la cuenta donde se puede escribir. Solo en modo `existing`. */
  async listCalendars(): Promise<{ items: CalendarChoice[] }> {
    const access = await this.accessTokenOrThrow('existing');
    try {
      const all = await this.provider.listCalendars({ accessToken: access.accessToken });
      return { items: all.filter((c) => c.writable).map((c) => ({ id: c.id, name: c.name, primary: c.primary })) };
    } catch (e) {
      throw await this.asUserError(e, access.id);
    }
  }

  /** Elige el calendario: el servidor comprueba contra Google que existe y se puede escribir ahí (no se confía en lo que manda la pantalla). */
  async chooseCalendar(calendarId: string): Promise<CalendarConnectionView> {
    const access = await this.accessTokenOrThrow('existing');
    let found;
    try {
      found = (await this.provider.listCalendars({ accessToken: access.accessToken })).find((c) => c.id === calendarId && c.writable);
    } catch (e) {
      throw await this.asUserError(e, access.id);
    }
    if (!found) throw new ValidationError([{ path: 'calendar_id', code: 'not_found', message: 'Ese calendario no existe en la cuenta o no se puede escribir en él' }]);
    await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(calendarConnections).for('update').limit(1);
      if (!cur || cur.mode !== 'existing' || cur.status === 'disconnected') throw new NotFoundError();
      const now = new Date();
      await tx.update(calendarConnections).set({ calendarId: found.id, calendarName: found.name.slice(0, 200), status: 'connected', connectedAt: cur.connectedAt ?? now, lastError: null, lastCheckAt: now, updatedAt: now }).where(eq(calendarConnections.id, cur.id));
      await writeAudit(tx, { entityType: 'calendar_connection', entityId: cur.id, field: 'calendar', oldValue: cur.calendarName, newValue: found.name, source: 'manual' });
    });
    return this.get();
  }

  // ------------------------------------------------------------------ desconectar

  /** Revoca el permiso en Google y BORRA el token cifrado. Los eventos ya creados se quedan en el calendario de Google (decisión del responsable, ADR-67). */
  async disconnect(): Promise<CalendarConnectionView> {
    const org = TenantContext.current().organizationId;
    const cur = await this.db.withTenant(async (tx) => (await tx.select().from(calendarConnections).limit(1))[0] ?? null);
    if (!cur) throw new NotFoundError();
    if (cur.status !== 'disconnected' && cur.credentialsSealed) {
      const token = this.openRefreshToken(cur.credentialsSealed, org);
      if (token) await this.provider.revoke({ token }).catch((e: unknown) => this.log.warn({ err: e instanceof Error ? e.name : 'desconocido' }, 'no se pudo revocar el permiso en Google (se borra igual aquí)'));
    }
    await this.db.withTenant(async (tx) => {
      const [now0] = await tx.select().from(calendarConnections).for('update').limit(1);
      if (!now0 || now0.status === 'disconnected') return;
      await tx.update(calendarConnections).set({ status: 'disconnected', credentialsSealed: null, keyVersion: null, calendarId: null, calendarName: null, accountMasked: null, scopes: '', lastError: null, connectedAt: null, updatedAt: new Date() }).where(eq(calendarConnections.id, now0.id));
      await writeAudit(tx, { entityType: 'calendar_connection', entityId: now0.id, field: 'status', oldValue: now0.status, newValue: 'disconnected', source: 'manual' });
    });
    return this.get();
  }

  // ------------------------------------------------------------------ internos

  private async client(): Promise<OAuthClient | null> {
    const c = await this.platform.active(CALENDAR_SERVICE);
    if (!c || c.provider !== 'google') return null;
    const clientId = c.values['client_id'];
    const clientSecret = c.values['client_secret'];
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  }

  private async unavailableReason(): Promise<Unavailable | null> {
    if (this.provider.kind === 'none') return 'provider';
    if (!this.vault || !this.stateKey) return 'encryption';
    if (!this.redirectUri) return 'base_url';
    if (!(await this.client())) return 'platform_credentials';
    return null;
  }

  private unavailable(reason: Unavailable): ServiceUnavailableError {
    const why: Record<Unavailable, string> = {
      provider: 'el servidor no tiene activado el calendario',
      encryption: 'el servidor no tiene configurado el cifrado de credenciales',
      base_url: 'el servidor no tiene configurada su dirección pública',
      platform_credentials: 'la plataforma todavía no tiene cargada la aplicación de Google',
    };
    return new ServiceUnavailableError('CALENDAR_UNAVAILABLE', `Por ahora no se puede conectar Google Calendar: ${why[reason]}. Avisa a soporte.`);
  }

  private openRefreshToken(sealed: string, org: string): string | null {
    try {
      return this.vault?.open(sealed, aadOf(org))['refresh_token'] ?? null;
    } catch (e) {
      if (e instanceof VaultOpenError) return null;
      throw e;
    }
  }

  /** Un access token fresco para la conexión del modo pedido. Un token rechazado deja la conexión en `needs_reconnect`. */
  private async accessTokenOrThrow(mode: CalendarMode): Promise<{ id: string; accessToken: string }> {
    const reason = await this.unavailableReason();
    if (reason !== null) throw this.unavailable(reason);
    const org = TenantContext.current().organizationId;
    const cur = await this.db.withTenant(async (tx) => (await tx.select().from(calendarConnections).limit(1))[0] ?? null);
    if (!cur || cur.mode !== mode || cur.status === 'disconnected' || !cur.credentialsSealed) throw new NotFoundError();
    if (cur.status === 'needs_reconnect') throw new ConflictError('CALENDAR_NEEDS_RECONNECT', 'Google ya no acepta la conexión: vuelve a conectar el calendario');
    const refreshToken = this.openRefreshToken(cur.credentialsSealed, org);
    if (!refreshToken) {
      await this.markNeedsReconnect(cur.id, 'La autorización guardada no se puede leer: vuelve a conectar');
      throw new ConflictError('CALENDAR_NEEDS_RECONNECT', 'La autorización guardada no se puede leer: vuelve a conectar el calendario');
    }
    try {
      const t = await this.provider.accessToken({ client: (await this.client())!, refreshToken });
      return { id: cur.id, accessToken: t.accessToken };
    } catch (e) {
      throw await this.asUserError(e, cur.id);
    }
  }

  private async markNeedsReconnect(id: string, text: string): Promise<void> {
    await this.db.withTenant(async (tx) => {
      const [cur] = await tx.select().from(calendarConnections).where(eq(calendarConnections.id, id)).for('update').limit(1);
      if (!cur || cur.status === 'needs_reconnect' || cur.status === 'disconnected') return;
      await tx.update(calendarConnections).set({ status: 'needs_reconnect', lastError: text.slice(0, 300), updatedAt: new Date() }).where(eq(calendarConnections.id, id));
      await writeAudit(tx, { entityType: 'calendar_connection', entityId: id, field: 'status', oldValue: cur.status, newValue: 'needs_reconnect', source: 'automation' });
    });
  }

  private async asUserError(e: unknown, connectionId: string): Promise<Error> {
    if (e instanceof CalendarError) {
      if (e.credentials) {
        await this.markNeedsReconnect(connectionId, e.message);
        return new ConflictError('CALENDAR_NEEDS_RECONNECT', e.message);
      }
      if (e.retryable) return new ServiceUnavailableError('CALENDAR_UNREACHABLE', 'No se pudo contactar a Google en este momento. Inténtalo de nuevo en unos minutos');
      return new ValidationError([{ path: 'calendar', code: 'rejected', message: e.message }]);
    }
    return new ServiceUnavailableError('CALENDAR_UNREACHABLE', 'No se pudo contactar a Google en este momento');
  }

  /** A dónde se vuelve a la persona (siempre dentro de nuestra web, con un resultado y sin datos). Sin dirección pública configurada, a la raíz. */
  private returnUrl(outcome: CalendarOutcome): string {
    return `${this.returnBase ?? '/settings/connections'}?calendar=${outcome}`;
  }
}
