/** Tarea periódica. `run` devuelve cuántos elementos procesó (solo para el log). */
export interface ScheduledJob {
  readonly name: string;
  readonly intervalMs: number;
  run(now: Date): Promise<number>;
}

export const SCHEDULED_JOBS = Symbol('SCHEDULED_JOBS');
