/**
 * Puerto de salida de eventos a Meta (Conversions API). Ningún módulo importa el SDK ni el cliente HTTP de Meta: solo este contrato (adaptadores, CLAUDE.md).
 * Las credenciales son de CADA empresa (dataset y token, M6.4): el adaptador no guarda ninguna, las recibe en cada llamada.
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

/** Credenciales de UNA empresa para la API de Conversiones. `testEventCode`: con él los eventos van a «Eventos de prueba» y no se cuentan. */
export interface CapiCredentials {
  datasetId: string;
  accessToken: string;
  testEventCode?: string | null;
}

/** Fallo de envío. `retryable`: si se puede reintentar (red, 5xx, límite) o es definitivo (credenciales, datos rechazados). El mensaje NO debe llevar secretos. */
export class CapiSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** El fallo es de las credenciales (token vencido o sin permiso, dataset inexistente): hay que corregirlas, reintentar no sirve. */
    readonly credentials = false,
  ) {
    super(message);
    this.name = 'CapiSendError';
  }
}

export interface CapiProvider {
  /** `none` = sin proveedor configurado: el job no envía y los eventos quedan pendientes. */
  readonly kind: 'none' | 'fake' | 'meta';
  /** ¿Necesita las credenciales de la empresa para enviar? (`meta` sí; el fake de pruebas no.) */
  readonly requiresCredentials: boolean;
  send(event: CapiEvent, credentials: CapiCredentials): Promise<void>;
  /** Comprueba que el dataset existe y que el token puede usarlo. Devuelve el nombre del dataset si Meta lo informa. Lanza `CapiSendError`. */
  verify(credentials: CapiCredentials): Promise<{ name: string | null }>;
}

export const CAPI_PROVIDER = Symbol('CAPI_PROVIDER');

/** Sin proveedor configurado. */
export class NoCapiProvider implements CapiProvider {
  readonly kind = 'none' as const;
  readonly requiresCredentials = false;
  send(): Promise<void> {
    return Promise.reject(new CapiSendError('No hay proveedor de Conversions API configurado', false));
  }
  verify(): Promise<{ name: string | null }> {
    return Promise.reject(new CapiSendError('No hay proveedor de Conversions API configurado', false));
  }
}
