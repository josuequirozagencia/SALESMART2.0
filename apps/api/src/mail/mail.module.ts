import { Module } from '@nestjs/common';
import type { AppConfig } from '../config';
import type { AppLogger } from '../logger';
import { APP_CONFIG, APP_LOGGER } from '../tokens';
import { ConsoleMailProvider, MemoryMailProvider, UnavailableMailProvider } from './fakes';
import { MAIL_PROVIDER } from './ports';
import { ResendMailProvider } from './resend.provider';

/**
 * Correo transaccional (infraestructura compartida: registro, restablecimiento, invitaciones y avisos de administración).
 * Proveedor real (ADR-37): Resend. 'none' → no disponible (503) o fakes de desarrollo/pruebas (la configuración los prohíbe en producción).
 */
@Module({
  providers: [
    {
      provide: MAIL_PROVIDER,
      useFactory: (cfg: AppConfig, log: AppLogger) => {
        switch (cfg.signup.mailProvider) {
          case 'resend': return new ResendMailProvider({ apiKey: cfg.providers.resendApiKey ?? '', from: cfg.providers.mailFrom ?? '' });
          case 'memory': return new MemoryMailProvider();
          case 'console': return new ConsoleMailProvider(log);
          default: return new UnavailableMailProvider();
        }
      },
      inject: [APP_CONFIG, APP_LOGGER],
    },
  ],
  exports: [MAIL_PROVIDER],
})
export class MailModule {}
