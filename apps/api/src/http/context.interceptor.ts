import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import type { AppLogger } from '../logger';
import { PlatformContext, TenantContext } from '../tenant';
import { APP_LOGGER } from '../tokens';
import type { AuthedRequest } from './access.guard';

/**
 * Establece el contexto (TenantContext / PlatformContext) para TODO lo que ocurre después: pipes, handler y
 * servicios. La organización sale únicamente del principal verificado por el guard (ADR-24 P5).
 */
@Injectable()
export class ContextInterceptor implements NestInterceptor {
  constructor(@Inject(APP_LOGGER) private readonly log: AppLogger) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const res = http.getResponse<Response>();
    const p = req.principal;
    const requestId = req.requestId;
    const started = Date.now();

    return new Observable((subscriber) => {
      const run = <T>(fn: () => T): T => {
        if (p?.kind === 'tenant') {
          return TenantContext.run(
            { organizationId: p.organizationId, userId: p.userId, actingAs: p.actingAs, actingOrgId: p.actingOrgId, requestId },
            fn,
          );
        }
        if (p?.kind === 'platform') return PlatformContext.run({ actorUserId: p.userId, requestId }, fn);
        return fn(); // rutas @Public()
      };
      const sub = run(() =>
        next.handle().subscribe({
          next: (v) => subscriber.next(v),
          error: (e: unknown) => subscriber.error(e),
          complete: () => {
            // Solo plantilla de ruta, método y estado: nunca query string ni cuerpo (PII). Un fallo de log no rompe la respuesta.
            try {
              this.log.info({ method: req.method, route: (req.route as { path?: string } | undefined)?.path, status: res.statusCode, ms: Date.now() - started }, 'petición');
            } catch {
              /* ignorado */
            }
            subscriber.complete();
          },
        }),
      );
      return () => sub.unsubscribe();
    });
  }
}
