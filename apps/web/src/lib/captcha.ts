/**
 * Anti-bots (Build Spec §15 #9, ADR-37). Proveedor real: Cloudflare Turnstile. Este módulo es el único que conoce el modo:
 *  - 'turnstile': widget visible/gestionado; el token es de UN solo uso y caduca (se pide uno nuevo tras cada envío).
 *  - 'fake': solo desarrollo y pruebas (exige CAPTCHA_PROVIDER=fake en el backend).
 *  - 'none' (por defecto): sin proveedor; el backend responde 503 (registro no disponible) antes de mirar el token.
 */
export type CaptchaMode = 'turnstile' | 'fake' | 'none';
export const FAKE_CAPTCHA_PASS = 'fake-pass';

export const captchaMode = (): CaptchaMode => {
  const m = import.meta.env.VITE_CAPTCHA_PROVIDER;
  return m === 'turnstile' || m === 'fake' ? m : 'none';
};

/** Token fijo de los modos sin widget. */
export const staticCaptchaToken = (mode: CaptchaMode): string => (mode === 'fake' ? FAKE_CAPTCHA_PASS : 'none');

/** Compatibilidad: token de los modos sin widget (fake/none). */
export const captchaToken = (): string => staticCaptchaToken(captchaMode());
