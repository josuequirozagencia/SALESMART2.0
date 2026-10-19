/**
 * Inicio del día (las 00:00) en la zona horaria de la organización, como instante UTC. El tope diario de un reparto cuenta desde ahí: un asesor de Guayaquil
 * empieza su día a las 05:00 UTC. Sirve para zonas con cambio de horario (el desfase se calcula en el propio instante de la medianoche).
 */
function offsetMs(at: Date, timeZone: string): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p['year']), Number(p['month']) - 1, Number(p['day']), Number(p['hour']), Number(p['minute']), Number(p['second']));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export function startOfLocalDay(now: Date, timeZone: string): Date {
  const o1 = offsetMs(now, timeZone);
  const local = new Date(now.getTime() + o1); // la hora de pared de la zona, leída como UTC
  const midnightWall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // El desfase puede ser otro a medianoche (cambio de horario ese día): se vuelve a calcular en ese instante
  const guess = midnightWall - o1;
  return new Date(midnightWall - offsetMs(new Date(guess), timeZone));
}
