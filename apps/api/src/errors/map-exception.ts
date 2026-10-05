import { HttpException } from '@nestjs/common';
import { AppError, type ErrorDetail } from './app-error';

export interface MappedError {
  status: number;
  code: string;
  message: string;
  details: readonly ErrorDetail[];
  /** true → es un fallo del servidor y se registra con la excepción completa (ya redactada por el logger). */
  log: boolean;
}

const BY_STATUS: Record<number, [code: string, message: string]> = {
  400: ['BAD_REQUEST', 'Solicitud mal formada'],
  401: ['UNAUTHORIZED', 'No autenticado'],
  403: ['FORBIDDEN', 'No tienes permiso para realizar esta acción'],
  404: ['NOT_FOUND', 'Recurso no encontrado'],
  405: ['METHOD_NOT_ALLOWED', 'Método no permitido'],
  409: ['CONFLICT', 'La operación entra en conflicto con el estado actual'],
  413: ['PAYLOAD_TOO_LARGE', 'La solicitud es demasiado grande'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Tipo de contenido no soportado'],
  429: ['RATE_LIMITED', 'Demasiadas solicitudes'],
};

function rootCause(e: unknown): unknown {
  let cur = e;
  for (let i = 0; i < 5 && cur instanceof Error && cur.cause !== undefined; i++) cur = cur.cause;
  return cur;
}

/** Códigos SQLSTATE con significado de negocio. El resto es un fallo del servidor. */
const PG_STATE: Record<string, [number, string, string]> = {
  '23505': [409, 'CONFLICT', 'El recurso ya existe'],
  '23503': [409, 'CONFLICT', 'La operación referencia un recurso que no existe o está en uso'],
  '23514': [400, 'VALIDATION_ERROR', 'Los datos enviados no son válidos'],
  '23502': [400, 'VALIDATION_ERROR', 'Los datos enviados no son válidos'],
  '22P02': [400, 'VALIDATION_ERROR', 'Los datos enviados no son válidos'],
};

/**
 * Convierte CUALQUIER excepción en una respuesta segura. Regla: el `message` de un error que no sea `AppError`
 * jamás sale al cliente (los errores de Drizzle incluyen SQL y parámetros; los de body-parser pueden repetir el cuerpo).
 */
export function mapException(exception: unknown): MappedError {
  if (exception instanceof AppError) {
    return { status: exception.status, code: exception.code, message: exception.message, details: exception.details, log: false };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const [code, message] = BY_STATUS[status] ?? (status >= 500 ? ['INTERNAL_ERROR', 'Error interno'] : ['BAD_REQUEST', 'Solicitud mal formada']);
    return { status, code, message, details: [], log: status >= 500 };
  }
  const cause = rootCause(exception) as { code?: unknown; type?: unknown; status?: unknown; statusCode?: unknown } | undefined;
  // Errores de body-parser (JSON inválido, cuerpo demasiado grande...)
  const httpStatus = typeof cause?.statusCode === 'number' ? cause.statusCode : typeof cause?.status === 'number' ? cause.status : undefined;
  if (typeof cause?.type === 'string' && httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    const [code, message] = BY_STATUS[httpStatus] ?? BY_STATUS[400]!;
    return { status: httpStatus, code, message, details: [], log: false };
  }
  if (typeof cause?.code === 'string' && PG_STATE[cause.code]) {
    const [status, code, message] = PG_STATE[cause.code]!;
    return { status, code, message, details: [], log: false };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Error interno', details: [], log: true };
}
