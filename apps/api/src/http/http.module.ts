import { DynamicModule, Inject, Module, OnApplicationBootstrap, Type } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Express, NextFunction, Request, Response } from 'express';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AllExceptionsFilter } from '../errors';
import { AccessGuard } from './access.guard';
import { AccessResolver, DenyAllAccessResolver } from './access-resolver';
import { ContextInterceptor } from './context.interceptor';

export interface HttpModuleOptions {
  /** Implementación del puerto de acceso. Por defecto DENIEGA todo (hasta M1). */
  accessResolver?: Type<AccessResolver>;
  /** Módulos que aportan las dependencias del resolvedor (p. ej. AuthModule). */
  imports?: NonNullable<DynamicModule['imports']>;
}

@Module({})
export class HttpModule implements OnApplicationBootstrap {
  constructor(@Inject(HttpAdapterHost) private readonly host: HttpAdapterHost) {}

  /**
   * Cierra la cadena de Express con un 404 JSON estándar. El manejador 404 de Nest solo cubre rutas bajo el prefijo
   * global (/v1); sin esto, `/lo-que-sea` caería en el 404 HTML de Express (sin request_id, revela la tecnología).
   * Se registra en onApplicationBootstrap: las rutas ya están montadas.
   */
  onApplicationBootstrap(): void {
    const express = this.host.httpAdapter.getInstance<Express>();
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
