import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { ServiceUnavailableError } from '../../errors';
import { APP_CONFIG } from '../../tokens';
import { CredentialVault, VaultOpenError } from '../platform';

const aadOf = (channelAccountId: string): string => `channel/${channelAccountId}`;

/**
 * Credenciales de los números de las empresas (ADR-50 #3): cifradas con la bóveda de ADR-42 y atadas a SU conexión por el AAD (`channel/<id>`), de modo que un
 * sobre copiado de una conexión a otra no se abre. Sin clave maestra en el servidor no se puede guardar ninguna (503).
 */
@Injectable()
export class ChannelVault {
  private readonly vault: CredentialVault | null;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.vault = CredentialVault.fromConfig(cfg.providers.credentialsKeys);
  }

  get available(): boolean {
    return this.vault !== null;
  }

  seal(channelAccountId: string, secrets: Readonly<Record<string, string>>): { sealed: string; keyVersion: number } {
    if (!this.vault) throw new ServiceUnavailableError('CHANNEL_VAULT_UNAVAILABLE', 'Por ahora no se pueden guardar conexiones: la plataforma aún no tiene configurado el cifrado de credenciales. Avisa a soporte');
    return this.vault.seal(secrets, aadOf(channelAccountId));
  }

  /** Abre el sobre de UNA conexión; null si no se pudo (clave cambiada o sobre alterado). Nunca devuelve ni registra el contenido. */
  open(channelAccountId: string, sealed: string): Record<string, string> | null {
    if (!this.vault) return null;
    try {
      return this.vault.open(sealed, aadOf(channelAccountId));
    } catch (e) {
      if (e instanceof VaultOpenError) return null;
      throw e;
    }
  }
}
