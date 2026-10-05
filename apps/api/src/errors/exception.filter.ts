import { ArgumentsHost, Catch, ExceptionFilter, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppLogger } from '../logger';
import { APP_LOGGER } from '../tokens';
import { TooManyAttemptsError } from './app-error';
import { mapException } from './map-exception';

/** Formato de error de la API: { error: { code, message, request_id, details } } (Build Spec §7). */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly log: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { requestId?: string }>();
    const res = http.getResponse<Response>();
    const mapped = mapException(exception);
    const requestId = req.requestId ?? 'unknown';

    if (mapped.log) this.log.error({ err: exception, request_id: requestId, method: req.method }, 'error no controlado');
    if (res.headersSent) return;
    if (exception instanceof TooManyAttemptsError) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(exception.retryAfterSeconds))));
    res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, request_id: requestId, details: mapped.details },
    });
  }
}
