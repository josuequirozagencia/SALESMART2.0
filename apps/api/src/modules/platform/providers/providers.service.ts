import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { AppConfig } from '../../../config';
import { Database, platformAudit, providerCredentials, providerSelection, type PlatformTx } from '../../../db';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError, type ErrorDetail } from '../../../errors';
import { PlatformContext } from '../../../tenant';
import { APP_CONFIG } from '../../../tokens';
import { PROVIDER_CATALOG, findProvider, findService, type FieldDef, type Maturity, type Managed, type ProviderDef, type ServiceDef } from './catalog';
import { CredentialVault, VaultOpenError } from './credential-vault';
import type { SaveCredentialsDto } from './providers.dto';

export interface FieldView {
  key: string;
  label: string;
  /** Cómo se teclea en la pantalla (oculto o a la vista). El servidor los trata igual: todos cifrados. */
  masked: boolean;
  required: boolean;
  hint: string | null;
  /** ¿Tiene valor guardado? */
  set: boolean;
  /** Los ÚLTIMOS 4 caracteres (null si no hay valor o es demasiado corto para mostrar nada). El valor completo NUNCA se devuelve. */
  last4: string | null;
}
export interface ProviderView {
  key: string;
  label: string;
  maturity: Maturity;
  note: string | null;
  /** Tiene todos los campos obligatorios (o, en los gestionados por el servidor, es el que está en uso). */
  configured: boolean;
  fields: FieldView[];
  updated_at: string | null;
}
export interface ServiceView {
  key: string;
  label: string;
  adapter: string;
  managed: Managed;
  note: string;
  /** Proveedor en uso (null = ninguno). */
  active: string | null;
  /** Solo en los servicios gestionados por variables de entorno: el modo actual (none, console, resend…). */
  mode: string | null;
  providers: ProviderView[];
}
export interface ProvidersList {
  /** ¿Hay clave maestra en el servidor para guardar credenciales? */
  vault: { available: boolean };
  services: ServiceView[];
}

type Row = typeof providerCredentials.$inferSelect;
const VALUE_RE = /^[\x21-\x7E]{1,1000}$/; // ASCII imprimible sin espacios (van en cabeceras, URL y cuerpos)

const iso = (d: Date): string => d.toISOString();
const aadOf = (service: string, provider: string): string => `${service}/${provider}`;
const hintOf = (v: string): string | null => (v.length >= 8 ? v.slice(-4) : null);

function hintsOf(row: Row | undefined): Record<string, string | null> {
  const h = row?.secretHints;
  if (!h || typeof h !== 'object' || Array.isArray(h)) return {};
  return Object.fromEntries(Object.entries(h as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : null]));
}

/** ¿Están todos los campos obligatorios guardados? */
function isConfigured(def: ProviderDef, keys: ReadonlySet<string>): boolean {
  return def.fields.every((f) => !f.required || keys.has(f.key));
}

function validUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !u.hash && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Proveedores de la plataforma (M2.6, ADR-21/ADR-42): solo el Súper Admin. Elegir el proveedor activo de cada servicio y guardar sus credenciales.
 *  - TODO valor se cifra con la bóveda (clave maestra del servidor) y NO se lee de vuelta; la API solo muestra los últimos 4. Sin clave maestra no se
 *    puede guardar ninguno (503); elegir el proveedor en uso sigue funcionando.
 *  - Todo cambio (credenciales, quitar, activar) va con su auditoría de plataforma EN LA MISMA transacción y solo con nombres de campos, nunca valores.
 *  - Las operaciones de un servicio se serializan con un candado de transacción: dos cambios simultáneos no se pisan.
 *  - Un proveedor ACTIVO no puede quedar incompleto ni sin credenciales: primero se desactiva.
 */
@Injectable()
export class ProvidersService {
  private readonly vault: CredentialVault | null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    this.vault = CredentialVault.fromConfig(cfg.providers.credentialsKeys);
  }

  async list(): Promise<ProvidersList> {
    const { rows, sel } = await this.db.withPlatform(async (tx) => ({
      rows: await tx.select().from(providerCredentials),
      sel: await tx.select().from(providerSelection),
    }));
    const byProvider = new Map(rows.map((r) => [aadOf(r.service, r.provider), r]));
    const active = new Map(sel.map((s) => [s.service, s.provider]));
    return { vault: { available: this.vault !== null }, services: PROVIDER_CATALOG.map((svc) => this.serviceView(svc, byProvider, active)) };
  }

  /** Elige (o quita con `null`) el proveedor en uso de un servicio gestionado por la plataforma. Solo uno con todos sus campos obligatorios. */
  async setActive(service: string, provider: string | null): Promise<{ service: string; active: string | null; changed: boolean }> {
    const svc = this.managedService(service);
    const def = provider === null ? null : (findProvider(svc, provider) ?? null);
    if (provider !== null && !def) throw new NotFoundError();
    const actor = PlatformContext.current();
    return this.db.withPlatform(async (tx) => {
      await this.lock(tx, service);
      const [cur] = await tx.select().from(providerSelection).where(eq(providerSelection.service, service)).limit(1);
      const previous = cur?.provider ?? null;
      if (previous === provider) return { service, active: provider, changed: false };
      if (def) {
        const [row] = await tx.select().from(providerCredentials).where(and(eq(providerCredentials.service, service), eq(providerCredentials.provider, def.key))).limit(1);
        if (!isConfigured(def, new Set(Object.keys(hintsOf(row))))) throw new ConflictError('PROVIDER_NOT_CONFIGURED', 'Faltan datos obligatorios de este proveedor: guárdalos antes de activarlo');
      }
      await tx
        .insert(providerSelection)
        .values({ service, provider, updatedBy: actor.actorUserId })
        .onConflictDoUpdate({ target: providerSelection.service, set: { provider, updatedAt: new Date(), updatedBy: actor.actorUserId } });
      await tx.insert(platformAudit).values({ action: provider ? 'provider.activated' : 'provider.deactivated', entityType: 'provider', actorUserId: actor.actorUserId, requestId: actor.requestId, details: { service, provider, previous } });
      return { service, active: provider, changed: true };
    });
  }

  /** Guarda (parcialmente) los valores de un proveedor. Devuelve su vista, sin ningún valor (solo los últimos 4). */
  async saveCredentials(service: string, provider: string, input: SaveCredentialsDto): Promise<ProviderView> {
    const svc = this.managedService(service);
    const def = findProvider(svc, provider);
    if (!def) throw new NotFoundError();
    const { values: newValues, clear } = this.validate(def, input);
    if (!this.vault) throw new ServiceUnavailableError('PROVIDER_VAULT_UNAVAILABLE', 'No se pueden guardar credenciales: falta la clave de cifrado en el servidor (PROVIDER_CREDENTIALS_KEY)');
    const vault = this.vault;
    const actor = PlatformContext.current();

    const out = await this.db.withPlatform(async (tx) => {
      await this.lock(tx, service);
      const [row] = await tx.select().from(providerCredentials).where(and(eq(providerCredentials.service, service), eq(providerCredentials.provider, provider))).limit(1);
      const hints = hintsOf(row);
      const values: Record<string, string> = row?.secretsSealed ? this.open(vault, row.secretsSealed, service, provider) : {};
      for (const [k, v] of Object.entries(newValues)) {
        values[k] = v;
        hints[k] = hintOf(v);
      }
      for (const k of clear) {
        delete values[k];
        delete hints[k];
      }
      let sealed: string | null = null;
      let keyVersion: number | null = null;
      if (Object.keys(values).length > 0) {
        const s = vault.seal(values, aadOf(service, provider));
        sealed = s.sealed;
        keyVersion = s.keyVersion;
      }

      // Un proveedor en uso no puede quedar incompleto
      const [sel] = await tx.select().from(providerSelection).where(eq(providerSelection.service, service)).limit(1);
      if (sel?.provider === provider && !isConfigured(def, new Set(Object.keys(hints)))) {
        throw new ConflictError('PROVIDER_ACTIVE', 'Este proveedor está en uso y quedaría incompleto: cámbialo o desactívalo primero');
      }
      const set = { secretsSealed: sealed, keyVersion, secretHints: hints, updatedAt: new Date(), updatedBy: actor.actorUserId };
      const [saved] = await tx
        .insert(providerCredentials)
        .values({ service, provider, ...set })
        .onConflictDoUpdate({ target: [providerCredentials.service, providerCredentials.provider], set })
        .returning();
      await tx.insert(platformAudit).values({
        action: 'provider.credentials_saved',
        entityType: 'provider',
        actorUserId: actor.actorUserId,
        requestId: actor.requestId,
        details: { service, provider, fields_changed: Object.keys(newValues), cleared: clear },
      });
      return saved as Row;
    });
    return this.providerView(def, out);
  }

  /** Quita TODAS las credenciales de un proveedor (no el que está en uso: primero se desactiva). */
  async clearCredentials(service: string, provider: string): Promise<{ service: string; provider: string; cleared: boolean }> {
    const svc = this.managedService(service);
    const def = findProvider(svc, provider);
    if (!def) throw new NotFoundError();
    const actor = PlatformContext.current();
    return this.db.withPlatform(async (tx) => {
      await this.lock(tx, service);
      const [sel] = await tx.select().from(providerSelection).where(eq(providerSelection.service, service)).limit(1);
      if (sel?.provider === provider) throw new ConflictError('PROVIDER_ACTIVE', 'Este proveedor está en uso: desactívalo antes de quitar sus credenciales');
      const del = await tx.delete(providerCredentials).where(and(eq(providerCredentials.service, service), eq(providerCredentials.provider, provider))).returning({ service: providerCredentials.service });
      if (del.length === 0) return { service, provider, cleared: false };
      await tx.insert(platformAudit).values({ action: 'provider.credentials_cleared', entityType: 'provider', actorUserId: actor.actorUserId, requestId: actor.requestId, details: { service, provider } });
      return { service, provider, cleared: true };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private managedService(key: string): ServiceDef {
    const svc = findService(key);
    if (!svc) throw new NotFoundError();
    if (svc.managed !== 'platform') throw new ConflictError('SERVICE_NOT_CONFIGURABLE', 'Este servicio no se configura aquí');
    return svc;
  }

  private lock(tx: PlatformTx, service: string): Promise<unknown> {
    return tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`providers:${service}`}, 0))`);
  }

  private open(vault: CredentialVault, sealed: string, service: string, provider: string): Record<string, string> {
    try {
      return vault.open(sealed, aadOf(service, provider));
    } catch (e) {
      if (e instanceof VaultOpenError) throw new ServiceUnavailableError('PROVIDER_VAULT_MISMATCH', 'No se pueden abrir las credenciales guardadas con la clave de cifrado actual del servidor');
      throw e;
    }
  }

  /** Valida claves y valores contra el catálogo. Devuelve lo normalizado; lanza un error de validación con las rutas que fallan (sin eco de los valores). */
  private validate(def: ProviderDef, input: SaveCredentialsDto): { values: Record<string, string>; clear: string[] } {
    const issues: ErrorDetail[] = [];
    const field = (k: string): FieldDef | undefined => def.fields.find((f) => f.key === k);
    const values: Record<string, string> = {};
    for (const [k, raw] of Object.entries(input.values ?? {})) {
      const f = field(k);
      const v = raw.trim();
      if (!f) issues.push({ path: `values.${k}`, code: 'unknown_field', message: 'Campo desconocido para este proveedor' });
      else if (!VALUE_RE.test(v)) issues.push({ path: `values.${k}`, code: 'invalid', message: 'Debe tener entre 1 y 1000 caracteres visibles, sin espacios' });
      else if (f.format === 'url' && !validUrl(v)) issues.push({ path: `values.${k}`, code: 'invalid_url', message: 'Debe ser una URL http(s) sin usuario, contraseña, parámetros ni fragmento' });
      else values[k] = v;
    }
    const clear = [...new Set(input.clear ?? [])];
    for (const k of clear) {
      if (!field(k)) issues.push({ path: 'clear', code: 'unknown_field', message: `Campo desconocido: ${k}` });
      if (k in values) issues.push({ path: 'clear', code: 'conflict', message: `${k} no puede guardarse y quitarse a la vez` });
    }
    if (issues.length > 0) throw new ValidationError(issues);
    return { values, clear };
  }

  private fieldViews(def: ProviderDef, row: Row | undefined): FieldView[] {
    const hints = hintsOf(row);
    return def.fields.map((f) => {
      const set = f.key in hints;
      return { key: f.key, label: f.label, masked: f.masked, required: f.required, hint: f.hint ?? null, set, last4: set ? (hints[f.key] ?? null) : null };
    });
  }

  private providerView(def: ProviderDef, row: Row | undefined, configuredOverride?: boolean): ProviderView {
    return {
      key: def.key,
      label: def.label,
      maturity: def.maturity,
      note: def.note ?? null,
      configured: configuredOverride ?? isConfigured(def, new Set(Object.keys(hintsOf(row)))),
      fields: this.fieldViews(def, row),
      updated_at: row ? iso(row.updatedAt) : null,
    };
  }

  private serviceView(svc: ServiceDef, rows: Map<string, Row>, active: Map<string, string | null>): ServiceView {
    const base = { key: svc.key, label: svc.label, adapter: svc.adapter, managed: svc.managed, note: svc.note };
    if (svc.managed === 'platform') {
      const sel = active.get(svc.key) ?? null;
      return { ...base, active: sel, mode: null, providers: svc.providers.map((p) => this.providerView(p, rows.get(aadOf(svc.key, p.key)))) };
    }
    if (svc.managed === 'env') {
      const mode = svc.key === 'mail' ? this.cfg.signup.mailProvider : this.cfg.signup.captchaProvider;
      const inUse = svc.providers[0] && ((svc.key === 'mail' && mode === 'resend') || (svc.key === 'captcha' && mode === 'turnstile')) ? svc.providers[0].key : null;
      return { ...base, active: inUse, mode, providers: svc.providers.map((p) => this.providerView(p, undefined, p.key === inUse)) };
    }
    // fixed / client: no se cambian aquí; el único proveedor es el que se usa
    const only = svc.providers[0];
    return { ...base, active: only?.key ?? null, mode: null, providers: svc.providers.map((p) => this.providerView(p, undefined, true)) };
  }
}
