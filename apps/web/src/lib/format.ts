/** «3 días y 4 h», «5 h», «menos de 1 h» o «vencida» (mismo criterio del prototipo). */
export function timeLeft(ms: number): string {
  if (ms <= 0) return 'vencida';
  const day = 86_400_000, hour = 3_600_000;
  const d = Math.floor(ms / day), h = Math.floor((ms % day) / hour);
  if (d >= 1) return `${d} día${d > 1 ? 's' : ''}${h ? ` y ${h} h` : ''}`;
  return h >= 1 ? `${h} h` : 'menos de 1 h';
}

export const shortDate = (iso: string): string => new Date(iso).toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit' });

/** «12/10 14:05» en la hora del navegador. */
export const shortDateTime = (iso: string): string => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
};

/** «3 h 05 min», «12 min», «menos de 1 min» (duración de un acceso, en segundos). */
export function durationLabel(seconds: number): string {
  if (seconds < 60) return 'menos de 1 min';
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}

/** Nivel de acceso de una agencia a un cliente, en palabras del producto. */
export const ACCESS_LEVEL_LABEL = { read: 'Solo lectura', advisor: 'Asesor', admin: 'Administrador' } as const;

export const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Súper Admin',
  agency: 'Agencia',
  client_admin: 'Administrador',
  advisor: 'Asesor',
};
