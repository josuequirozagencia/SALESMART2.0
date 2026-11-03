/**
 * Puerto de correo transaccional (infraestructura compartida por `auth` y `organizations`). El núcleo solo conoce esta interfaz:
 * el adaptador real (Resend, ADR-37) y los fakes viven en este directorio. Cada adaptador tiene su fake y su contract test.
 */
export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');

export interface VerificationMail {
  to: string;
  /** Código en claro: SOLO existe aquí y en el correo; la BD guarda su HMAC. Nunca se registra en logs de producción. */
  code: string;
  expiresInMinutes: number;
}

export interface PasswordResetMail {
  to: string;
  /**
   * Enlace COMPLETO `<FRONTEND_BASE_URL><RESET_LINK_PATH>#token=<token>`, construido en el servidor a partir de configuración
   * explícita (nunca del Host de la petición). El token va en el fragmento: no llega a servidores, logs ni cabeceras Referer.
   * El token existe en claro solo aquí y en el correo (la BD guarda su SHA-256); no se registra.
   */
  resetUrl: string;
  expiresInMinutes: number;
}

export interface InvitationMail {
  to: string;
  /** Nombre de la empresa o agencia a la que se invita (se escapa en la plantilla). */
  organizationName: string;
  /** Qué se administrará: cambia solo el texto del correo. Por defecto, una empresa. */
  kind?: 'client' | 'agency';
  /**
   * Enlace COMPLETO `<FRONTEND_BASE_URL><INVITE_LINK_PATH>#token=<token>` (mismo criterio que `resetUrl`: lo arma el servidor, el token va en
   * el fragmento y existe en claro solo aquí y en el correo; la BD guarda su SHA-256; no se registra).
   */
  inviteUrl: string;
  expiresInDays: number;
}

/** Aviso al administrador de un cliente cuando cambia quién administra su cuenta (ADR-22; ADR-40). */
export interface OwnershipChangeMail {
  to: string;
  organizationName: string;
  /** Agencia que la administra a partir de ahora; `null` = administración directa (sin agencia). */
  agencyName: string | null;
  /** Agencia que la administraba antes; `null` = no tenía. */
  previousAgencyName: string | null;
}

/** Aviso de que una empresa fue eliminada (F3, ADR-59 #14): al dueño y a la agencia que la administraba. No lleva enlaces: no se puede entrar a una empresa eliminada. */
export interface CompanyDeletedMail {
  to: string;
  organizationName: string;
  /** Hasta cuándo se puede recuperar; después se borra definitivamente. */
  purgeAfter: Date;
  /** Zona horaria con la que se muestra la fecha (la de la empresa). */
  timeZone: string;
  /** A quién se escribe: cambia el texto (el dueño pierde su acceso; la agencia, su cliente). */
  audience: 'owner' | 'agency';
  /** Solo para el dueño (F3b): enlace de un solo propósito para pedir y bajar la copia completa de sus datos. El token va en el fragmento (#token=…), nunca en la ruta. */
  exportUrl?: string;
}

/** Aviso al dueño de que la copia completa de sus datos ya está lista (F3b, ADR-59 #9). El enlace lleva a una página que pide su contraseña antes de entregar la descarga. */
export interface CompanyExportReadyMail {
  to: string;
  organizationName: string;
  downloadUrl: string;
  /** Hasta cuándo se puede bajar (las partes se borran a las 48 horas). */
  expiresAt: Date;
  timeZone: string;
  parts: number;
  totalBytes: number;
}

/** Aviso de que una empresa eliminada fue recuperada (F3, ADR-59 #14). */
export interface CompanyRecoveredMail {
  to: string;
  organizationName: string;
  audience: 'owner' | 'agency';
}

export interface MailProvider {
  /** false = no hay proveedor configurado: el registro responde 503 en lugar de fingir que envió. */
  readonly available: boolean;
  sendVerificationCode(mail: VerificationMail): Promise<void>;
  sendPasswordReset(mail: PasswordResetMail): Promise<void>;
  sendInvitation(mail: InvitationMail): Promise<void>;
  sendOwnershipChange(mail: OwnershipChangeMail): Promise<void>;
  sendCompanyDeleted(mail: CompanyDeletedMail): Promise<void>;
  sendCompanyExportReady(mail: CompanyExportReadyMail): Promise<void>;
  sendCompanyRecovered(mail: CompanyRecoveredMail): Promise<void>;
}
