/**
 * Registro en curso entre «Crear cuenta» y «Verificar correo». Solo en MEMORIA: la contraseña nunca va a la URL, al
 * estado del historial (que sobrevive a recargas) ni al almacenamiento del navegador. Se usa una única vez para entrar
 * automáticamente al verificar el correo y se borra.
 */
interface Pending { email: string; password?: string }
let pending: Pending | null = null;

export const pendingSignup = {
  set: (p: Pending): void => { pending = p; },
  get: (): Pending | null => pending,
  /** Entrega la contraseña una sola vez y la olvida. */
  takePassword: (): string | undefined => {
    const p = pending?.password;
    if (pending) pending = { email: pending.email };
    return p;
  },
  clear: (): void => { pending = null; },
};
