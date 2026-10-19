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
    // Proveedores (ADR-42): el servidor ya redacta el motivo para el Súper Admin (sin datos secretos)
    case 'PROVIDER_NOT_CONFIGURED': case 'PROVIDER_ACTIVE': case 'PROVIDER_VAULT_UNAVAILABLE': case 'PROVIDER_VAULT_MISMATCH': case 'SERVICE_NOT_CONFIGURABLE': return e.message;
    // Contactos (ADR-43): el servidor ya redacta el motivo para la persona
    case 'PHONE_TAKEN': return 'Uno de los teléfonos ya pertenece a otro contacto de tu empresa.';
    case 'OWNER_NOT_ALLOWED': return e.message;
    // Campos personalizados (ADR-44): el servidor ya redacta el motivo
    case 'CUSTOM_FIELD_EXISTS': case 'CUSTOM_FIELD_KEY_RESERVED': case 'CUSTOM_FIELD_LIMIT': case 'CUSTOM_FIELD_ARCHIVED': case 'CUSTOM_FIELD_ORDER_STALE': return e.message;
    // Etiquetas y listas (ADR-46): el servidor ya redacta el motivo
    case 'TAG_EXISTS': case 'TAG_SYSTEM': case 'TAG_LIMIT': case 'LIST_EXISTS': case 'LIST_LIMIT': case 'LIST_FULL': case 'LIST_NOT_FIXED': case 'LIST_NOT_DYNAMIC': case 'LIST_NOT_YOURS': case 'LIST_SHARE_NOT_ALLOWED': return e.message;
    // Pipelines y etapas (ADR-49): el servidor ya redacta el motivo
    case 'PIPELINE_EXISTS': case 'PIPELINE_LIMIT': case 'PIPELINE_LAST': case 'PIPELINE_HAS_OPPORTUNITIES': case 'PIPELINE_ORDER_STALE': case 'STAGE_EXISTS': case 'STAGE_LIMIT': case 'STAGE_KIND_TAKEN': case 'STAGE_KIND_HAS_OPPORTUNITIES': case 'STAGE_WON_REQUIRED': case 'STAGE_WON_HIDDEN': case 'STAGE_LAST_OPEN': case 'STAGE_HAS_CLOSED_OPPORTUNITIES': case 'STAGE_ORDER_STALE': case 'STAGE_HIDDEN': case 'OPPORTUNITY_OPEN_EXISTS': return e.message;
    // Empresas, notas y tareas (ADR-48): el servidor ya redacta el motivo
    case 'COMPANY_EXISTS': case 'COMPANY_LIMIT': case 'NOTE_NOT_YOURS': case 'TASK_NOT_YOURS': case 'TASK_SCOPE': case 'TASK_ASSIGNEE_NOT_ALLOWED': return e.message;
    // Conexiones de canales (ADR-50): el servidor ya redacta el motivo (sin datos secretos)
    case 'CHANNEL_EXISTS': case 'CHANNEL_NUMBER_IN_USE': case 'CHANNEL_LIMIT': case 'CHANNEL_TOKEN_INVALID': case 'CHANNEL_NUMBER_NOT_FOUND': case 'CHANNEL_PROVIDER_UNAVAILABLE': case 'CHANNEL_CREDENTIALS_UNREADABLE': case 'CHANNEL_VAULT_UNAVAILABLE': case 'CHANNEL_QUEUE_NOT_FOUND': return e.message;
    // Colas y reparto (ADR-07): el servidor ya redacta el motivo
    case 'QUEUE_EXISTS': case 'QUEUE_LIMIT': case 'QUEUE_IN_USE': case 'QUEUE_DISTRIBUTION_OFF': return e.message;
    // Inbox (ADR-16/50): el servidor ya redacta el motivo
    case 'WINDOW_CLOSED': case 'CONVERSATION_CLOSED': case 'CONVERSATION_UNASSIGNED': case 'CONVERSATION_STATE': case 'NOT_OWNER': case 'NOT_ASSIGNABLE': case 'CHANNEL_DISABLED': case 'MESSAGE_NOT_FAILED': return e.message;
    // Importar y exportar (ADR-47): el servidor ya redacta el motivo
    case 'IMPORT_DUPLICATE_FILE': return 'Este archivo ya se importó. Si quieres repetirlo, cancela la importación anterior o cambia el archivo.';
    case 'IMPORT_NOT_STAGING': case 'IMPORT_NOT_READY': case 'IMPORT_NOT_RUNNING': case 'IMPORT_LOCKED': case 'IMPORT_ROW_OUT_OF_ORDER': case 'EXPORT_TOO_LARGE': return e.message;
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
