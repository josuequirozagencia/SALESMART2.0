/**
 * Lo que el reparto necesita saber de la empresa y que vive en tablas de IDENTIDAD (no se pueden leer dentro de una transacción de negocio): su zona horaria y quiénes
 * pueden recibir trabajo hoy. Quien llama lo resuelve ANTES de abrir la transacción y se lo pasa al reparto.
 */
export interface AssignmentContext {
  /** El «ahora» del reparto (el tope diario cuenta desde la medianoche local de este instante). */
  readonly now: Date;
  readonly timeZone: string;
  /** Personas de la empresa que pueden recibir trabajo (administradores y asesores vigentes). */
  readonly assignable: ReadonlySet<string>;
}

/** `closed`: la cola respeta el horario y ahora está cerrada (fuera de horario o feriado): el lead espera y se reparte al abrir. */
export type AssignReason = 'distributed' | 'cartera' | 'off' | 'none_available' | 'closed';

export interface Assignment {
  readonly ownerId: string | null;
  readonly reason: AssignReason;
}
