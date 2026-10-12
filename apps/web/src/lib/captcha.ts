/**
 * Token anti-bots. El proveedor real (hCaptcha/Turnstile) NO está decidido (Build Spec §15 #9): este módulo es el único
 * lugar a cambiar. 'fake' solo existe en desarrollo/pruebas y exige CAPTCHA_PROVIDER=fake en el backend; con 'none' el
 * backend responde 503 (registro no disponible) antes de mirar el token.
 */
export const FAKE_CAPTCHA_PASS = 'fake-pass';

export function captchaToken(): string {
  return import.meta.env.VITE_CAPTCHA_PROVIDER === 'fake' ? FAKE_CAPTCHA_PASS : 'none';
}
