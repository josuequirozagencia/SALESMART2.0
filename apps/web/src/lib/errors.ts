import { ApiError } from './api';

export function waitText(seconds: number): string {
  if (seconds < 90) return `${seconds} segundos`;
  const m = Math.ceil(seconds / 60);
  return m < 90 ? `${m} minutos` : `${Math.ceil(m / 60)} horas`;
}

/** Texto para el usuario a partir de un error de la API. Nunca revela si un correo existe (el servidor ya es uniforme). */
export function friendlyError(e: unknown, fallback = 'No pudimos completar la acción. Inténtalo de nuevo.'): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.status === 0) return e.message;
  if (e.status === 429) return `Demasiados intentos. Inténtalo de nuevo ${e.retryAfterSeconds ? `en ${waitText(e.retryAfterSeconds)}` : 'más tarde'}.`;
  switch (e.code) {
    case 'SIGNUP_UNAVAILABLE': return 'El registro no está disponible por el momento. Inténtalo más tarde.';
    case 'PASSWORD_RESET_UNAVAILABLE': return 'La recuperación de contraseña no está disponible por el momento. Inténtalo más tarde.';
    case 'EMAIL_DOMAIN_NOT_ALLOWED': return 'Usa un correo de trabajo o personal permanente, no uno temporal.';
    case 'INVALID_CODE': return 'Código inválido o vencido. Revisa los 6 dígitos o pide uno nuevo.';
    case 'INVALID_TOKEN': return 'El enlace es inválido o venció. Pide uno nuevo.';
    case 'EXTENSION_NOT_PENDING': return 'Esta solicitud ya fue resuelta (quizá por otra persona). Se actualizó la lista.';
    case 'EXTENSION_ALREADY_USED': return 'Tu cuenta ya usó su extensión.';
    case 'VALIDATION_ERROR': return 'Revisa los datos ingresados.';
    case 'UNAUTHORIZED': return 'Correo o contraseña incorrectos.';
    default: return e.status >= 500 ? 'Tuvimos un problema de nuestro lado. Inténtalo en unos minutos.' : fallback;
  }
}
