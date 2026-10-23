import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { AuthedRequest } from '../../http/access.guard';
import { RealtimeService } from './realtime.service';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const CONVERSATION_PATH = new RegExp(`/conversations/(${UUID})(?:/|$)`);
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Lo que una persona hace desde la pantalla (aceptar, tomar, finalizar, responder, transferir, compartir, programar, adjuntar…) pasa por rutas de
 * `/conversations/:id/…` (y el reintento por `/messages/:id/retry`): al terminar bien, se avisa de la conversación una sola vez, sin tocar cada servicio.
 * Lo que ocurre sin petición (mensajes entrantes, estados de entrega, tareas) avisa desde su propio servicio.
 */
@Injectable()
export class RealtimeInterceptor implements NestInterceptor {
  constructor(@Inject(RealtimeService) private readonly realtime: RealtimeService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!WRITES.has(req.method) || req.principal?.kind !== 'tenant') return next.handle();
    const organizationId = req.principal.organizationId;
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    const fromPath = CONVERSATION_PATH.exec(path)?.[1];
    const isRetry = /\/messages\/[^/]+\/retry$/.test(path);
    if (!fromPath && !isRetry) return next.handle();
    return next.handle().pipe(
      tap((result) => {
        try {
          const body = (result ?? {}) as { conversation_id?: unknown; id?: unknown };
          const conversationId = fromPath ?? (typeof body.conversation_id === 'string' ? body.conversation_id : undefined);
          if (!conversationId) return;
          this.realtime.touch(organizationId, conversationId.toLowerCase(), isRetry && typeof body.id === 'string' ? { message: { id: body.id, kind: 'updated' } } : {});
        } catch {
          // el aviso es opcional: nunca puede romper la respuesta
        }
      }),
    );
  }
}
