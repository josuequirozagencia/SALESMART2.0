import type { INestApplication } from '@nestjs/common';
import type { Express, NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';
import { rawBodyFor } from './raw-body';
import { RequestIdMiddleware } from './request-id.middleware';

/** Prefijo de versión de la API (Build Spec §7). Todas las rutas lo llevan salvo las de sondeo de infraestructura. */
export const API_PREFIX = 'v1';
/** Sondeos de salud: sin versión (los usan balanceadores/orquestadores). Cualquier otra ruta DEBE ir bajo /v1. */
export const UNVERSIONED_ROUTES: readonly string[] = ['health', 'health/ready'];
/** Webhooks cuya firma se calcula sobre el cuerpo exacto: se leen crudos (Buffer) antes del lector JSON. Ruta completa, con prefijo. */
export const RAW_BODY_ROUTES: readonly string[] = [`/${API_PREFIX}/channels/meta/webhook`];
const RAW_BODY_LIMIT_BYTES = 1024 * 1024;

/** Ajustes HTTP comunes (producción y tests). La web servida por la API lleva su propia CSP (web-static.ts); sin CORS: un solo origen (ADR-36). */
export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as Express;
  express.disable('x-powered-by');
  // IP real del cliente detrás de un proxy (límites por IP): solo con saltos de confianza configurados explícitamente
  let hops = 0;
  try {
    hops = app.get<AppConfig>(APP_CONFIG, { strict: false }).trustProxyHops;
  } catch {
    /* aplicaciones sin CoreModule (pruebas de fixtures): sin proxy */
  }
  if (hops > 0) express.set('trust proxy', hops);
  // request_id en TODAS las respuestas (también /health y rutas inexistentes fuera de /v1): primer middleware de Express.
  // Un middleware de Nest no sirve: con prefijo global solo cubre rutas bajo /v1.
  const requestId = new RequestIdMiddleware();
  express.use((req: Request, res: Response, next: NextFunction) => requestId.use(req, res, next));
  express.use(rawBodyFor(RAW_BODY_ROUTES, RAW_BODY_LIMIT_BYTES));
  app.setGlobalPrefix(API_PREFIX, { exclude: [...UNVERSIONED_ROUTES] });
}
