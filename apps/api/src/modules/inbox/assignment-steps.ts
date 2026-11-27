/**
 * Quién tuvo la conversación (V24), reconstruido desde la auditoría de `owner_id` —no hay tabla propia—. Lógica pura.
 *  - Nuevo dueño vacío → se liberó.
 *  - Sin persona detrás (`automation` o `api`): sin dueño anterior = reparto automático; con dueño anterior = reasignación por falta de respuesta.
 *  - Una persona sobre una conversación sin dueño que se la queda = la tomó; sobre una sin dueño para otra = asignación manual; sobre una con dueño = transferencia.
 */
export type AssignmentKind = 'distribution' | 'reassigned' | 'taken' | 'assigned' | 'transferred' | 'released';

export interface OwnerChange {
  from: string | null;
  to: string | null;
  actorId: string | null;
  source: string;
}

export function kindOf(c: OwnerChange): AssignmentKind {
  if (c.to === null) return 'released';
  if (c.source === 'automation' || c.source === 'api') return c.from === null ? 'distribution' : 'reassigned';
  if (c.from !== null) return 'transferred';
  return c.actorId === c.to ? 'taken' : 'assigned';
}

/** Solo lo hizo una persona (en lo automático la auditoría puede traer a quien disparó la acción, que no «pidió» el cambio). */
export const byPerson = (kind: AssignmentKind): boolean => kind !== 'distribution' && kind !== 'reassigned';
