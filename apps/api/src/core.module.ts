import { Global, Module } from '@nestjs/common';
import { loadConfig, type AppConfig } from './config';
import { createLogger } from './logger';
import { APP_CONFIG, APP_LOGGER } from './tokens';

/** Configuración validada y logger: globales para toda la aplicación. */
@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: APP_LOGGER, useFactory: (cfg: AppConfig) => createLogger({ level: cfg.logLevel }), inject: [APP_CONFIG] },
  ],
  exports: [APP_CONFIG, APP_LOGGER],
})
export class CoreModule {}
