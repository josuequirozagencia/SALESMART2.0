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
    case 'INVALID_INVITATION': return 'La invitación no es válida o ya se usó.';
    case 'INVITATION_EXPIRED': return 'La invitación venció. Pide que te la reenvíen.';
    case 'INVALID_PASSWORD': return 'La contraseña no es correcta.';
    case 'INVITATIONS_UNAVAILABLE': return 'Las invitaciones no están disponibles: falta configurar la URL de la aplicación en el servidor.';
    case 'AGENCY_NOT_FOUND': case 'AGENCY_SUSPENDED': case 'NO_AGENCY': return e.message;
    case 'INVITATION_ALREADY_ACCEPTED': return 'Esta invitación ya fue aceptada.';
    // Mensajes del servidor ya redactados para la persona (nombres de plan duplicados, plan en uso…)
    case 'PLAN_NAME_TAKEN': case 'PLAN_IN_USE': case 'PLAN_ARCHIVED': case 'PLAN_NOT_FOUND': return e.message;
    case 'EXTENSION_NOT_PENDING': return 'Esta solicitud ya fue resuelta (quizá por otra persona). Se actualizó la lista.';
    case 'EXTENSION_ALREADY_USED': return 'Tu cuenta ya usó su extensión.';
    case 'VALIDATION_ERROR': return 'Revisa los datos ingresados.';
    case 'UNAUTHORIZED': return 'Correo o contraseña incorrectos.';
    default: return e.status >= 500 ? 'Tuvimos un problema de nuestro lado. Inténtalo en unos minutos.' : fallback;
  }
}
