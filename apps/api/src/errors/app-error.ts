/**
 * Errores de aplicación con mensaje SEGURO para el cliente. Solo `AppError` puede llevar texto al exterior;
 * cualquier otro error (Drizzle, pg, Error genérico) se responde con un mensaje genérico (ver map-exception).
 */
export interface ErrorDetail {
  path: string;
  code: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly ErrorDetail[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details: readonly ErrorDetail[]) {
    super(400, 'VALIDATION_ERROR', 'Los datos enviados no son válidos', details);
  }
}
/** Mensaje deliberadamente genérico: no revela si el usuario/correo existe ni por qué falló. */
export class UnauthorizedError extends AppError {
  constructor() {
    super(401, 'UNAUTHORIZED', 'No autenticado');
  }
}
export class ForbiddenError extends AppError {
  constructor(code = 'FORBIDDEN', message = 'No tienes permiso para realizar esta acción') {
    super(403, code, message);
  }
}
/** También se usa cuando el recurso existe pero pertenece a otra organización: nunca se distingue. */
export class NotFoundError extends AppError {
  constructor() {
    super(404, 'NOT_FOUND', 'Recurso no encontrado');
  }
}
/** 429 con espera: el filtro añade la cabecera Retry-After. No revela si la cuenta existe (el bloqueo aplica igual a correos inexistentes). */
export class TooManyAttemptsError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'TOO_MANY_ATTEMPTS', 'Demasiados intentos. Inténtalo de nuevo más tarde');
  }
}
export class ConflictError extends AppError {
  constructor(code = 'CONFLICT', message = 'La operación entra en conflicto con el estado actual') {
    super(409, code, message);
  }
}
/** 503: funcionalidad sin proveedor configurado (p. ej. registro sin servicio de correo). */
export class ServiceUnavailableError extends AppError {
  constructor(code = 'SERVICE_UNAVAILABLE', message = 'Servicio no disponible por el momento') {
    super(503, code, message);
  }
}
/** 400 genérico y uniforme para cualquier fallo de verificación de código (no distingue causa). */
export class InvalidVerificationCodeError extends AppError {
  constructor() {
    super(400, 'INVALID_CODE', 'Código inválido o vencido');
  }
}
/** 400 uniforme para cualquier fallo de un token de restablecimiento (inexistente, usado, vencido, usuario no apto). */
export class InvalidResetTokenError extends AppError {
  constructor() {
    super(400, 'INVALID_TOKEN', 'Enlace inválido o vencido');
  }
}
