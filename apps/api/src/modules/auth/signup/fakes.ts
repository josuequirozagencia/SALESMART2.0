import type { CaptchaVerifier } from './ports';

export class UnavailableCaptchaVerifier implements CaptchaVerifier {
  readonly available = false;
  verify(): Promise<boolean> {
    return Promise.resolve(false);
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
