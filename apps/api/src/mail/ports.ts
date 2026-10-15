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

export interface MailProvider {
  /** false = no hay proveedor configurado: el registro responde 503 en lugar de fingir que envió. */
  readonly available: boolean;
  sendVerificationCode(mail: VerificationMail): Promise<void>;
  sendPasswordReset(mail: PasswordResetMail): Promise<void>;
  sendInvitation(mail: InvitationMail): Promise<void>;
  sendOwnershipChange(mail: OwnershipChangeMail): Promise<void>;
}
