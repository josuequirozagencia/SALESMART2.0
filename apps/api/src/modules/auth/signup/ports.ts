/**
 * Puerto del anti-bots del registro (M1.2, ADR-37). El de correo vive en `src/mail`.
 */
export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER');

export interface CaptchaVerifier {
  readonly available: boolean;
  /** true solo si el token es válido. Un fallo del proveedor se trata como false (falla cerrado). */
  verify(input: { token: string; ip?: string }): Promise<boolean>;
}
