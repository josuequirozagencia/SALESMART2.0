import { offsetMs } from '../../time/zone';

/**
 * Inicio del día (las 00:00) en la zona horaria de la organización, como instante UTC. El tope diario de un reparto cuenta desde ahí: un asesor de Guayaquil
 * empieza su día a las 05:00 UTC. Sirve para zonas con cambio de horario (el desfase se calcula en el propio instante de la medianoche).
 */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const o1 = offsetMs(now, timeZone);
  const local = new Date(now.getTime() + o1); // la hora de pared de la zona, leída como UTC
  const midnightWall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // El desfase puede ser otro a medianoche (cambio de horario ese día): se vuelve a calcular en ese instante
  const guess = midnightWall - o1;
  return new Date(midnightWall - offsetMs(new Date(guess), timeZone));
}
