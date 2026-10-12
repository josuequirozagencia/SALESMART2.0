/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** 'fake' (solo desarrollo/pruebas, el backend también debe tener CAPTCHA_PROVIDER=fake) o 'none'. Sin proveedor real elegido todavía. */
  readonly VITE_CAPTCHA_PROVIDER?: 'turnstile' | 'fake' | 'none';
  /** Clave de SITIO de Cloudflare Turnstile (pública). La clave secreta vive solo en el servidor. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}
