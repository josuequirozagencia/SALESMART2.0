/**
 * Límites de envío y calentamiento de una sesión de WhatsApp por QR (M9.6, ADR-54/ADR-31). Funciones PURAS. WhatsApp puede bloquear un número vinculado por QR que envía de golpe o mucho desde
 * el primer día: el sistema **calienta** el número (pocos mensajes los primeros días) y deja una pausa mínima entre mensajes. Valores PROVISIONALES: se calibran con el uso real del primer chip.
 */
export const MIN_GAP_MS = 4_000;
const DAY_MS = 86_400_000;

/** Tope del primer tramo para un chip con el calentamiento dispensado (ADR-54 enmienda «waiver»): el cliente declaró que el número ya tenía uso previo y aceptó el riesgo de bloqueo al conectar por QR. */
export const WARMUP_WAIVED_DAILY_LIMIT = 200;

/**
 * Cuántos mensajes al día puede enviar la sesión según los días que lleva conectada. Con el calentamiento dispensado (`warmupWaived`) arranca en {@link WARMUP_WAIVED_DAILY_LIMIT} (200) y también
 * crece con el tiempo, pero más rápido y hasta un techo más alto que el calentamiento normal: 200 la primera semana, 350 hasta la segunda, 500 hasta la tercera y 800 después. Sin waiver sube más
 * despacio desde un piso más bajo: 20 los dos primeros días, 50 hasta el cuarto, 100 hasta el octavo y 250 después.
 */
export function dailyLimit(firstConnectedAt: Date | null, now: Date, warmupWaived = false): number {
  const day = firstConnectedAt ? Math.floor((now.getTime() - firstConnectedAt.getTime()) / DAY_MS) : 0;
  if (warmupWaived) return day < 7 ? 200 : day < 14 ? 350 : day < 21 ? 500 : 800;
  if (!firstConnectedAt) return 20;
  return day < 2 ? 20 : day < 4 ? 50 : day < 8 ? 100 : 250;
}

/** El día de calentamiento (1 = el primero). */
export function warmupDay(firstConnectedAt: Date | null, now: Date): number {
  return firstConnectedAt ? Math.max(1, Math.floor((now.getTime() - firstConnectedAt.getTime()) / DAY_MS) + 1) : 1;
}

export type SendGate = { ok: true } | { ok: false; reason: 'gap' | 'daily'; retryAt: Date };

/**
 * ¿Se puede enviar AHORA? `sentLast24h` son los mensajes que la sesión ya envió en las últimas 24 h y `lastSentAt` la hora del último. Si no, devuelve cuándo volver a intentar: tras la pausa
 * mínima, o cuando el envío más antiguo de la ventana salga de ella (aproximado con una hora desde ahora, porque el límite es por ventana móvil). `replyInWindow`: es la respuesta a un cliente que escribió
 * en las últimas 24 h (la campaña y el contacto en frío NO lo son): esa no cuenta contra el límite del día. Lo que se escribió desde el TELÉFONO no se cuenta (quien llama lo excluye).
 */
export function sendGate(input: { sentLast24h: number; lastSentAt: Date | null; firstConnectedAt: Date | null; now: Date; replyInWindow?: boolean; warmupWaived?: boolean }): SendGate {
  const { now } = input;
  // La pausa mínima entre mensajes NUNCA se dispensa, ni con el calentamiento declarado como dispensado: es la única fricción anti-patrón-bot que queda.
  if (input.lastSentAt && now.getTime() - input.lastSentAt.getTime() < MIN_GAP_MS) return { ok: false, reason: 'gap', retryAt: new Date(input.lastSentAt.getTime() + MIN_GAP_MS) };
  // Contestar a quien escribió primero (dentro de sus 24 h) no es envío en frío: no se frena con el límite del día, solo con la pausa mínima (ADR-54, enmienda v19)
  if (!input.replyInWindow && input.sentLast24h >= dailyLimit(input.firstConnectedAt, now, input.warmupWaived)) return { ok: false, reason: 'daily', retryAt: new Date(now.getTime() + 60 * 60_000) };
  return { ok: true };
}
