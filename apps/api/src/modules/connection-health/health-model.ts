/**
 * Salud de las conexiones (v19 B1/B4): qué mirar, cuándo preocuparse y cómo decirlo. Todo PURO (sin base de datos ni reloj propio) para probarlo sin red. Los números salen de lo que ya se guarda: la hora
 * que informó el proveedor de cada mensaje (`sent_at`) frente a la de su entrada (`created_at`), y el estado de los avisos del webhook.
 */

/** Retraso mediano (segundos) a partir del cual una conexión pasa a «atención» y a «crítico». */
export const LAG_WARN_S = 60;
export const LAG_CRIT_S = 300;
/** Cuántos mensajes hacen falta en la ventana para opinar del retraso (con menos es ruido). */
export const MIN_LAG_SAMPLES = 3;
/** Un aviso pendiente que lleva más de esto esperando DESPUÉS de su hora indica que la tarea va atrasada. */
export const BACKLOG_S = 60;
/** Horas de horario laboral sin recibir ningún aviso (de una sesión abierta) a partir de las cuales se pregunta si algo se cortó. */
export const SILENT_HOURS = 6;
/** Ventana para decidir la alerta de retraso (la pantalla muestra las últimas 24 h). */
export const ALERT_LAG_WINDOW_MS = 30 * 60_000;
export const HEALTH_WINDOW_MS = 24 * 3_600_000;

/** Por qué una conexión necesita atención. */
export type HealthReason = 'lag' | 'silent' | 'failed' | 'backlog' | 'session_down';
export type HealthLevel = 'ok' | 'warn' | 'crit';

/** Las razones que generan una alerta al administrador (la sesión caída ya tiene su aviso propio en Conexiones). */
export const ALERT_REASONS = ['lag', 'silent', 'failed', 'backlog'] as const;
export type AlertReason = (typeof ALERT_REASONS)[number];

export interface HealthFacts {
  /** Mensajes entrantes en la ventana y su retraso mediano (s); null sin mensajes. */
  readonly lagCount: number;
  readonly lagMedianS: number | null;
  /** Avisos del webhook: pendientes cuya hora ya venció hace más de {@link BACKLOG_S}, y fallidos (agotaron intentos). */
  readonly overdueEvents: number;
  readonly failedEvents: number;
  /** Solo WhatsApp por QR: estado de la sesión. */
  readonly sessionState: 'created' | 'connecting' | 'open' | 'logged_out' | 'closed' | null;
  /** Horas de horario laboral desde el último aviso recibido (o desde que se conectó); null si no aplica. */
  readonly silentBusinessHours: number | null;
}

export interface HealthVerdict {
  readonly level: HealthLevel;
  readonly reasons: readonly HealthReason[];
}

/** Juzga una conexión: crítico si hay avisos fallidos, la sesión está caída o el retraso mediano pasa de 5 min; atención por retraso de 1 min, avisos atrasados o silencio en horario laboral. */
export function judge(f: HealthFacts): HealthVerdict {
  const reasons: HealthReason[] = [];
  let level: HealthLevel = 'ok';
  const raise = (l: HealthLevel): void => {
    if (l === 'crit' || (l === 'warn' && level === 'ok')) level = l;
  };
  if (f.sessionState === 'closed' || f.sessionState === 'logged_out') {
    reasons.push('session_down');
    raise('crit');
  }
  if (f.failedEvents > 0) {
    reasons.push('failed');
    raise('crit');
  }
  if (f.lagMedianS !== null && f.lagCount >= MIN_LAG_SAMPLES) {
    if (f.lagMedianS > LAG_CRIT_S) {
      reasons.push('lag');
      raise('crit');
    } else if (f.lagMedianS > LAG_WARN_S) {
      reasons.push('lag');
      raise('warn');
    }
  }
  if (f.overdueEvents > 0) {
    reasons.push('backlog');
    raise('warn');
  }
  if (f.sessionState === 'open' && f.silentBusinessHours !== null && f.silentBusinessHours >= SILENT_HOURS) {
    reasons.push('silent');
    raise('warn');
  }
  return { level, reasons };
}

/** ¿Estas razones piden avisar al administrador? Solo las graves: retraso crítico, avisos fallidos, tarea atrasada y silencio prolongado. */
export function alertReasons(f: HealthFacts): AlertReason[] {
  const out: AlertReason[] = [];
  if (f.failedEvents > 0) out.push('failed');
  if (f.lagMedianS !== null && f.lagCount >= MIN_LAG_SAMPLES && f.lagMedianS > LAG_CRIT_S) out.push('lag');
  if (f.overdueEvents > 0) out.push('backlog');
  if (f.sessionState === 'open' && f.silentBusinessHours !== null && f.silentBusinessHours >= SILENT_HOURS) out.push('silent');
  return out;
}

/** El motivo de un aviso fallido en palabras de la persona (la columna guarda solo «Clase:código», nunca el texto del cliente). */
export function describeError(lastError: string | null): string {
  if (!lastError) return 'No se pudo procesar el aviso (sin detalle).';
  const [name, code] = lastError.split(':');
  if (code?.startsWith('23')) return 'La base de datos rechazó un dato del aviso (llave repetida o dato inválido).';
  if (code === '40001' || code === '40P01') return 'La base de datos estaba ocupada con otro cambio al mismo tiempo.';
  if (code?.startsWith('08') || code?.startsWith('57')) return 'Se cortó la conexión con la base de datos mientras se procesaba.';
  if (name === 'TypeError' || name === 'SyntaxError' || name === 'RangeError') return 'El aviso trae un formato que no se pudo leer.';
  if (name === 'AiUnavailableError') return 'Un servicio externo no respondió al procesar el aviso.';
  return `No se pudo procesar el aviso (${lastError}).`;
}

/** El texto fijo de cada alerta que ve el administrador en su centro de avisos. */
export const ALERT_TEXT: Record<AlertReason, string> = {
  lag: 'Los mensajes de esta conexión están llegando con mucho retraso desde WhatsApp.',
  silent: 'Esta conexión lleva horas sin recibir ningún aviso en horario laboral. Puede haberse cortado.',
  failed: 'Hay avisos de esta conexión que no se pudieron procesar. Puedes reintentarlos.',
  backlog: 'Los avisos de esta conexión se están procesando con retraso.',
};
