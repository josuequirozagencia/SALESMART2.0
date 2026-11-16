/**
 * Quién puede restablecer el acceso de quién (ADR-71). Funciones puras: sin base de datos ni contexto, para probar la tabla completa de casos.
 *
 * Ruta de EMPRESA (`POST /v1/users/:userId/reset-access`): la persona debe tener UNA sola membresía vigente (la de esa empresa) con rol `advisor` o `client_admin`. Quien tiene
 * más de una (por ejemplo el personal de una agencia, que tiene una membresía por cliente) o es de otro tipo (agencia, Súper Admin) solo la restablece el Súper Admin por la ruta de
 * PLATAFORMA. El administrador del cliente nunca puede con el dueño; la agencia sí salvo que la política lo prohíba.
 */

export type ResetActorKind = 'client_admin' | 'agency' | 'super_admin';

/** Quien actúa dentro de una empresa, según la marca `actingAs` del contexto (sin marca = el propio administrador del cliente). */
export const actorKindOf = (actingAs: 'super_admin' | 'agency' | undefined): ResetActorKind => actingAs ?? 'client_admin';

export interface CompanyTarget {
  /** Rol de su membresía vigente en ESTA empresa (`advisor`, `client_admin`, u otro). */
  roleHere: string;
  /** Cuántas membresías vigentes tiene en total (en cualquier empresa o en la plataforma). */
  activeMemberships: number;
  isOwner: boolean;
}

export type CompanyVerdict = { ok: true } | { ok: false; reason: 'not_member' | 'not_allowed' };

export function companyVerdict(actor: ResetActorKind, t: CompanyTarget, agencyCanResetOwner: boolean): CompanyVerdict {
  // Una persona de otro tipo en esta empresa (la agencia, un Súper Admin) no figura en el equipo del cliente: para quien pregunta es como si no existiera
  if (t.roleHere !== 'advisor' && t.roleHere !== 'client_admin') return { ok: false, reason: 'not_member' };
  if (t.activeMemberships !== 1) return { ok: false, reason: 'not_allowed' };
  if (t.isOwner && actor === 'client_admin') return { ok: false, reason: 'not_allowed' };
  if (t.isOwner && actor === 'agency' && !agencyCanResetOwner) return { ok: false, reason: 'not_allowed' };
  return { ok: true };
}

export const REASON_MIN = 10;
export const REASON_MAX = 300;

/** El motivo es obligatorio para la agencia y el Súper Admin; para el administrador del cliente es opcional (si lo escribe, rige el mismo mínimo). */
export function reasonProblem(actor: ResetActorKind, raw: string | undefined): { reason: string | null; problem: string | null } {
  const reason = (raw ?? '').trim();
  if (reason.length === 0) return actor === 'client_admin' ? { reason: null, problem: null } : { reason: null, problem: `Escribe el motivo (al menos ${REASON_MIN} caracteres)` };
  if (reason.length < REASON_MIN) return { reason, problem: `El motivo debe tener al menos ${REASON_MIN} caracteres` };
  if (reason.length > REASON_MAX) return { reason, problem: `El motivo no puede pasar de ${REASON_MAX} caracteres` };
  return { reason, problem: null };
}

/** `an***@empresa.com`: lo suficiente para que quien lo pidió reconozca la bandeja, nunca el correo entero. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, Math.min(2, local.length))}***${email.slice(at)}`;
}
