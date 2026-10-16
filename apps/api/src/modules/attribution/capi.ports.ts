/**
 * Puerto de salida de eventos a Meta (Conversions API). Ningún módulo importa el SDK ni el cliente HTTP de Meta: solo este contrato (adaptadores, CLAUDE.md).
 * En M3.3 no existe aún el adaptador real (llega en M6 con las credenciales del pixel por empresa, ADR-45 #5): hay un adaptador vacío (`none`) y un fake.
 */
export type CapiEventType = 'Lead' | 'Schedule' | 'Purchase' | 'SaleCanceled';

export interface CapiEvent {
  /** Estable: Meta lo usa para no duplicar y nosotros para no encolar dos veces. */
  eventId: string;
  type: CapiEventType;
  eventTime: Date;
  /** Cuerpo del evento tal como se enviará (datos de usuario ya con huella SHA-256: nunca el teléfono en claro). */
  payload: Record<string, unknown>;
}

/** Fallo de envío. `retryable`: si se puede reintentar (red, 5xx, límite) o es definitivo (credenciales, datos rechazados). El mensaje NO debe llevar secretos. */
export class CapiSendError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'CapiSendError';
  }
}

export interface CapiProvider {
  /** `none` = sin proveedor configurado: el job no envía y los eventos quedan pendientes. */
  readonly kind: 'none' | 'fake' | 'meta';
  send(event: CapiEvent): Promise<void>;
}

export const CAPI_PROVIDER = Symbol('CAPI_PROVIDER');

/** Sin proveedor configurado (estado actual de producción hasta M6). */
export class NoCapiProvider implements CapiProvider {
  readonly kind = 'none' as const;
  send(): Promise<void> {
    return Promise.reject(new CapiSendError('No hay proveedor de Conversions API configurado', false));
  }
}
