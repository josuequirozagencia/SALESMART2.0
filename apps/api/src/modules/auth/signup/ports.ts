/**
 * Puertos de integración del registro (M1.2). NO hay proveedor elegido (decisión abierta de correo y CAPTCHA):
 * el dominio solo conoce estas interfaces; los adaptadores reales se añadirán sin tocar el servicio.
 */
export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');
export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER');

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

export interface MailProvider {
  /** false = no hay proveedor configurado: el registro responde 503 en lugar de fingir que envió. */
  readonly available: boolean;
  sendVerificationCode(mail: VerificationMail): Promise<void>;
  sendPasswordReset(mail: PasswordResetMail): Promise<void>;
}

export interface CaptchaVerifier {
  readonly available: boolean;
  /** true solo si el token es válido. Un fallo del proveedor se trata como false (falla cerrado). */
  verify(input: { token: string; ip?: string }): Promise<boolean>;
}
