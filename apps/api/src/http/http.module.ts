import { DynamicModule, Inject, Module, OnApplicationBootstrap, Type } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Express, NextFunction, Request, Response } from 'express';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { AppConfig } from '../config';
import { AllExceptionsFilter } from '../errors';
import { APP_CONFIG } from '../tokens';
import { AccessGuard } from './access.guard';
import { AccessResolver, DenyAllAccessResolver } from './access-resolver';
import { ContextInterceptor } from './context.interceptor';
import { mountWeb } from './web-static';

export interface HttpModuleOptions {
  /** Implementación del puerto de acceso. Por defecto DENIEGA todo (hasta M1). */
  accessResolver?: Type<AccessResolver>;
  /** Módulos que aportan las dependencias del resolvedor (p. ej. AuthModule). */
  imports?: NonNullable<DynamicModule['imports']>;
}

@Module({})
export class HttpModule implements OnApplicationBootstrap {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /**
   * Cierra la cadena de Express con un 404 JSON estándar. El manejador 404 de Nest solo cubre rutas bajo el prefijo
   * global (/v1); sin esto, `/lo-que-sea` caería en el 404 HTML de Express (sin request_id, revela la tecnología).
   * Se registra en onApplicationBootstrap: las rutas ya están montadas.
   */
  onApplicationBootstrap(): void {
    const express = this.host.httpAdapter.getInstance<Express>();
    // Con WEB_DIST_DIR la API también sirve la web (mismo origen, ADR-36); si no, solo el 404 JSON estándar
    if (this.cfg.web.distDir) return mountWeb(express, { distDir: this.cfg.web.distDir, production: this.cfg.nodeEnv === 'production' });
    express.use((req: Request & { requestId?: string }, res: Response, _next: NextFunction) => {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Recurso no encontrado', request_id: req.requestId ?? 'unknown', details: [] } });
    });
  }

  static forRoot(opts: HttpModuleOptions = {}): DynamicModule {
    return {
      module: HttpModule,
      imports: opts.imports ?? [],
      providers: [
        { provide: AccessResolver, useClass: opts.accessResolver ?? DenyAllAccessResolver },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_INTERCEPTOR, useClass: ContextInterceptor },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
      exports: [AccessResolver],
    };
  }
}
