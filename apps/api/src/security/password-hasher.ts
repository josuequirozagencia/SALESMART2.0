import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * Hash de contraseñas con Argon2id (ADR-25 / Build Spec §seguridad). Parámetros PROVISIONALES
 * (m=19456 KiB, t=2, p=1: mínimo recomendado por OWASP); se calibran en carga real antes de producción.
 * La salida es el formato PHC estándar (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`), que incluye los
 * parámetros: permite subir el coste en el futuro y detectar hashes a re-hashear (`needsRehash`).
 */
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(stored: string, plain: string): Promise<boolean>;
  needsRehash(stored: string): boolean;
}

export interface Argon2Params {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}
export const DEFAULT_ARGON2_PARAMS: Argon2Params = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const MAX_PASSWORD_LENGTH = 1024; // evita DoS por contraseñas enormes

export class Argon2idHasher implements PasswordHasher {
  constructor(private readonly params: Argon2Params = DEFAULT_ARGON2_PARAMS) {}

  hash(plain: string): Promise<string> {
    if (plain.length === 0 || plain.length > MAX_PASSWORD_LENGTH) return Promise.reject(new Error('longitud de contraseña inválida'));
    return hash(plain, { algorithm: Algorithm.Argon2id, ...this.params });
  }

  async verify(stored: string, plain: string): Promise<boolean> {
    if (plain.length === 0 || plain.length > MAX_PASSWORD_LENGTH) return false;
    if (!stored.startsWith('$argon2id$')) return false;
    try {
      return await verify(stored, plain);
    } catch {
      return false; // hash corrupto: nunca autentica
    }
  }

  needsRehash(stored: string): boolean {
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
    if (!m) return true;
    return Number(m[1]) < this.params.memoryCost || Number(m[2]) < this.params.timeCost || Number(m[3]) !== this.params.parallelism;
  }
}
