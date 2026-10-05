import type { AppLogger } from '../../../logger';
import type { CaptchaVerifier, MailProvider, PasswordResetMail, VerificationMail } from './ports';

/** Sin proveedor: el servicio informa que no está disponible. Es el valor por defecto (y el único válido hoy en producción). */
export class UnavailableMailProvider implements MailProvider {
  readonly available = false;
  sendVerificationCode(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
  sendPasswordReset(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
}
export class UnavailableCaptchaVerifier implements CaptchaVerifier {
  readonly available = false;
  verify(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** SOLO PRUEBAS: guarda los correos en memoria. La configuración lo rechaza en producción. */
export class MemoryMailProvider implements MailProvider {
  readonly available = true;
  readonly outbox: VerificationMail[] = [];
  readonly resetOutbox: PasswordResetMail[] = [];
  failNext = false;
  sendVerificationCode(mail: VerificationMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.outbox.push(mail);
    return Promise.resolve();
  }
  sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.resetOutbox.push(mail);
    return Promise.resolve();
  }
  lastReset(to: string): PasswordResetMail | undefined {
    return [...this.resetOutbox].reverse().find((m) => m.to === to);
  }
  /** Extrae el token del fragmento del enlace (solo pruebas). */
  lastResetToken(to: string): string | undefined {
    const url = this.lastReset(to)?.resetUrl;
    return url ? new URL(url).hash.replace(/^#token=/, '') : undefined;
  }
  last(to: string): VerificationMail | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to);
  }
}

/** SOLO DESARROLLO: imprime el código en el log para poder completar el flujo sin proveedor. Rechazado en producción. */
export class ConsoleMailProvider implements MailProvider {
  readonly available = true;
  constructor(private readonly log: AppLogger) {}
  sendVerificationCode(mail: VerificationMail): Promise<void> {
    this.log.warn({ to: mail.to, code: mail.code }, 'DEV ONLY: correo de verificación (no se envía)');
    return Promise.resolve();
  }
  sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    this.log.warn({ to: mail.to, resetUrl: mail.resetUrl }, 'DEV ONLY: correo de restablecimiento (no se envía)');
    return Promise.resolve();
  }
}

/** SOLO PRUEBAS/DESARROLLO: acepta únicamente el token literal `fake-pass`. Rechazado en producción. */
export const FAKE_CAPTCHA_PASS = 'fake-pass';
export class FakeCaptchaVerifier implements CaptchaVerifier {
  readonly available = true;
  verify(input: { token: string }): Promise<boolean> {
    return Promise.resolve(input.token === FAKE_CAPTCHA_PASS);
  }
}
