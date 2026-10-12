/** «3 días y 4 h», «5 h», «menos de 1 h» o «vencida» (mismo criterio del prototipo). */
export function timeLeft(ms: number): string {
  if (ms <= 0) return 'vencida';
  const day = 86_400_000, hour = 3_600_000;
  const d = Math.floor(ms / day), h = Math.floor((ms % day) / hour);
  if (d >= 1) return `${d} día${d > 1 ? 's' : ''}${h ? ` y ${h} h` : ''}`;
  return h >= 1 ? `${h} h` : 'menos de 1 h';
}

export const shortDate = (iso: string): string => new Date(iso).toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit' });

export const ROLE_LABEL: Record<string, string> = {
  super_admin: 'Súper Admin',
  agency: 'Agencia',
  client_admin: 'Administrador',
  advisor: 'Asesor',
};
