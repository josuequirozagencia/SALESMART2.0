import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { AppConfig } from '../../../config';
import { Database, providerCredentials, providerSelection } from '../../../db';
import { PlatformContext, TenantContext } from '../../../tenant';
import { APP_CONFIG } from '../../../tokens';
import { CredentialVault, VaultOpenError } from './credential-vault';

/** Usuario «del sistema» para lecturas de plataforma que no vienen de una persona (p. ej. un webhook). Solo lectura: nunca firma una auditoría. */
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const CACHE_MS = 30_000;

export interface ActiveCredentials {
  /** El proveedor que la plataforma tiene EN USO para el servicio. */
  readonly provider: string;
  /** Los valores ya descifrados. Solo existen en memoria del servidor, nunca se devuelven por la API ni se registran. */
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Lector de las credenciales de la PLATAFORMA para los adaptadores del servidor (M5.2, ADR-42/50). Resuelve «cómo leen los adaptadores las credenciales»:
 * devuelve las del proveedor en uso de un servicio, descifradas, solo si TODOS los datos obligatorios están y la clave maestra abre el sobre. Es la única
 * lectura de valores secretos que existe: la API de «Proveedores» sigue mostrando solo los últimos 4.
 * Guarda el resultado 30 s en memoria (cada aviso de un webhook lo consulta): un cambio de credenciales tarda como mucho ese tiempo en notarse.
 */
@Injectable()
export class PlatformCredentialsReader {
  private readonly vault: CredentialVault | null;
  private readonly cache = new Map<string, { at: number; value: ActiveCredentials | null }>();

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) cfg: AppConfig,
  ) {
    this.vault = CredentialVault.fromConfig(cfg.providers.credentialsKeys);
  }

  /** Las credenciales del proveedor en uso de un servicio; null si no hay ninguno en uso, faltan datos o no se pueden abrir. */
  async active(service: string, now = Date.now()): Promise<ActiveCredentials | null> {
    const hit = this.cache.get(service);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const value = await this.load(service);
    this.cache.set(service, { at: now, value });
    return value;
  }

  /** Olvida lo guardado (pruebas, y para notar al instante un cambio hecho en este mismo proceso). */
  invalidate(service?: string): void {
    if (service) this.cache.delete(service);
    else this.cache.clear();
  }

  private async load(service: string): Promise<ActiveCredentials | null> {
    if (!this.vault) return null;
    const vault = this.vault;
    const read = () =>
      this.db.withPlatform(async (tx) => {
        const [sel] = await tx.select().from(providerSelection).where(eq(providerSelection.service, service)).limit(1);
        if (!sel?.provider) return null; // el servicio no tiene proveedor en uso
        const [row] = await tx.select().from(providerCredentials).where(and(eq(providerCredentials.service, service), eq(providerCredentials.provider, sel.provider))).limit(1);
        return row?.secretsSealed ? { provider: sel.provider, sealed: row.secretsSealed } : null;
      });
    // Desde una petición de empresa (adjuntos) se sale de su contexto para leer como «el sistema»: los contextos son excluyentes y no se anidan
    const found = PlatformContext.currentOrNull() ? await read() : await TenantContext.detach(() => PlatformContext.run({ actorUserId: SYSTEM_ACTOR }, read));
    if (!found) return null;
    try {
      return { provider: found.provider, values: vault.open(found.sealed, `${service}/${found.provider}`) };
    } catch (e) {
      if (e instanceof VaultOpenError) return null; // la clave maestra cambió y no abre el sobre: se trata como «sin credenciales»
      throw e;
    }
  }
}
