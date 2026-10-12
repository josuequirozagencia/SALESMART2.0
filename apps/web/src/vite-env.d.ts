/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** 'fake' (solo desarrollo/pruebas, el backend también debe tener CAPTCHA_PROVIDER=fake) o 'none'. Sin proveedor real elegido todavía. */
  readonly VITE_CAPTCHA_PROVIDER?: 'fake' | 'none';
}
