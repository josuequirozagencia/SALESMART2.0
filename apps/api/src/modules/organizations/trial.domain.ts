/**
 * Reglas puras de la prueba gratuita (ADR-23). Sin acceso a datos: se prueban sin base de datos.
 * El acceso se decide por la HORA (`endsAt`); `status` solo materializa lo que ya dice el reloj.
 */
export type TrialStatus = 'active' | 'expired';
export type ExtensionStatus = 'none' | 'pending' | 'approved' | 'denied';

export interface TrialClock {
  status: string;
  endsAt: Date;
}

/** Vencida si el job ya la marcó o si su fin ya pasó (un job caído no deja una cuenta vencida con acceso). */
export function isTrialExpired(t: TrialClock, now: Date): boolean {
  return t.status === 'expired' || t.endsAt.getTime() <= now.getTime();
}

/**
 * Nuevo fin tras aprobar la extensión (ADR-23 #4): aprobada ANTES de vencer suma al fin vigente; si ya venció, cuenta
 * desde la aprobación.
 */
export function extendedEnd(currentEnd: Date, approvedAt: Date, days: number): Date {
  const base = currentEnd.getTime() > approvedAt.getTime() ? currentEnd : approvedAt;
  return new Date(base.getTime() + days * 86_400_000);
}

/** Una sola extensión por cuenta: solo se puede pedir mientras nunca se haya pedido. */
export const canRequestExtension = (s: ExtensionStatus): boolean => s === 'none';
