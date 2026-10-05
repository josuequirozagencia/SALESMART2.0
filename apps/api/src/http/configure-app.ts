import type { INestApplication } from '@nestjs/common';
import type { Express, NextFunction, Request, Response } from 'express';
import { RequestIdMiddleware } from './request-id.middleware';

/** Prefijo de versión de la API (Build Spec §7). Todas las rutas lo llevan salvo las de sondeo de infraestructura. */
export const API_PREFIX = 'v1';
/** Sondeos de salud: sin versión (los usan balanceadores/orquestadores). Cualquier otra ruta DEBE ir bajo /v1. */
export const UNVERSIONED_ROUTES: readonly string[] = ['health', 'health/ready'];

/** Ajustes HTTP comunes (producción y tests). CORS/CSRF/CSP llegan con el bloque de seguridad web. */
export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as Express;
  express.disable('x-powered-by');
  // request_id en TODAS las respuestas (también /health y rutas inexistentes fuera de /v1): primer middleware de Express.
  // Un middleware de Nest no sirve: con prefijo global solo cubre rutas bajo /v1.
  const requestId = new RequestIdMiddleware();
  express.use((req: Request, res: Response, next: NextFunction) => requestId.use(req, res, next));
  app.setGlobalPrefix(API_PREFIX, { exclude: [...UNVERSIONED_ROUTES] });
}
