/** Validaciones de formulario (ayuda de UI: el servidor valida siempre). Reflejan las reglas aprobadas en M1.2/M1.3. */
export const PASSWORD_MIN = 8; // 8 <= SIGNUP_PASSWORD_MIN_LENGTH <= 128 (aprobado); el servidor puede exigir más si se configura
export const PASSWORD_MAX = 128;

export const isEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;
export const normalizeEmail = (v: string): string => v.trim().toLowerCase();

export function passwordError(v: string): string | undefined {
  if (v.length < PASSWORD_MIN) return `Usa al menos ${PASSWORD_MIN} caracteres`;
  if (v.length > PASSWORD_MAX) return `Usa como máximo ${PASSWORD_MAX} caracteres`;
  return undefined;
}

export const isSixDigits = (v: string): boolean => /^\d{6}$/.test(v);
