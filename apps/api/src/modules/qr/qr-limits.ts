/**
 * Límites de envío y calentamiento de una sesión de WhatsApp por QR (M9.6, ADR-54/ADR-31). Funciones PURAS. WhatsApp puede bloquear un número vinculado por QR que envía de golpe o mucho desde
 * el primer día: el sistema **calienta** el número (pocos mensajes los primeros días) y deja una pausa mínima entre mensajes. Valores PROVISIONALES: se calibran con el uso real del primer chip.
 */
export const MIN_GAP_MS = 4_000;
const DAY_MS = 86_400_000;

/** Cuántos mensajes al día puede enviar la sesión según los días que lleva conectada: 20 los dos primeros, 50 hasta el cuarto, 100 hasta el octavo y 250 después. */
export function dailyLimit(firstConnectedAt: Date | null, now: Date): number {
  if (!firstConnectedAt) return 20;
  const day = Math.floor((now.getTime() - firstConnectedAt.getTime()) / DAY_MS);
  return day < 2 ? 20 : day < 4 ? 50 : day < 8 ? 100 : 250;
}

/** El día de calentamiento (1 = el primero). */
export function warmupDay(firstConnectedAt: Date | null, now: Date): number {
  return firstConnectedAt ? Math.max(1, Math.floor((now.getTime() - firstConnectedAt.getTime()) / DAY_MS) + 1) : 1;
}

export type SendGate = { ok: true } | { ok: false; reason: 'gap' | 'daily'; retryAt: Date };

/**
 * ¿Se puede enviar AHORA? `sentLast24h` son los mensajes que la sesión ya envió en las últimas 24 h y `lastSentAt` la hora del último. Si no, devuelve cuándo volver a intentar: tras la pausa
 * mínima, o cuando el envío más antiguo de la ventana salga de ella (aproximado con una hora desde ahora, porque el límite es por ventana móvil).
 */
export function sendGate(input: { sentLast24h: number; lastSentAt: Date | null; firstConnectedAt: Date | null; now: Date }): SendGate {
  const { now } = input;
  if (input.lastSentAt && now.getTime() - input.lastSentAt.getTime() < MIN_GAP_MS) return { ok: false, reason: 'gap', retryAt: new Date(input.lastSentAt.getTime() + MIN_GAP_MS) };
  if (input.sentLast24h >= dailyLimit(input.firstConnectedAt, now)) return { ok: false, reason: 'daily', retryAt: new Date(now.getTime() + 60 * 60_000) };
  return { ok: true };
}
