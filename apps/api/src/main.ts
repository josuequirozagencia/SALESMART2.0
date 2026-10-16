import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { describeConfig, loadConfig } from './config';
import { configureApp } from './http';
import { createLogger } from './logger';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig(); // falla rápido si la configuración es inválida
  const log = createLogger({ level: cfg.logLevel });
  const app = await NestFactory.create(AppModule, { bufferLogs: true, logger: false, abortOnError: false });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(cfg.httpPort);
  log.info({ config: describeConfig(cfg) }, 'API iniciada');
  // ADR-42: sin la clave maestra la pantalla de proveedores no puede guardar credenciales. Es opcional en staging, pero obligatoria antes de abrir a usuarios reales.
  if (cfg.nodeEnv === 'production' && cfg.providers.credentialsKeys === undefined) {
    log.warn('PROVIDER_CREDENTIALS_KEY no está configurada: «Proveedores» no puede guardar credenciales. Es obligatoria antes de abrir a usuarios reales (ADR-42).');
  }
}

bootstrap().catch((e: unknown) => {
  // El logger puede no existir si la config es inválida: stderr directo, sin valores sensibles
  process.stderr.write(`Fallo de arranque: ${e instanceof Error ? e.message : 'desconocido'}\n`);
  process.exit(1);
});
