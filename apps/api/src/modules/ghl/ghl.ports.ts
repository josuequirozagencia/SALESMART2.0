/**
 * Puerto de GoHighLevel (M7, ADR-52/ADR-05). Ningún módulo importa un cliente HTTP de GHL: solo este contrato (adaptadores, CLAUDE.md). Las credenciales son de CADA empresa (token
 * de integración privada y Location): el adaptador no guarda ninguna, las recibe en cada llamada. Hoy solo existe `PrivateTokenProvider`; OAuth (ADR-05) queda diseñado, no construido,
 * y se enchufaría aquí sin que nadie más se entere.
 */
export interface GhlCredentials {
  /** Location (subcuenta) de GHL. */
  locationId: string;
  /** Token de integración privada. */
  accessToken: string;
}

/** Fallo de una llamada a GHL. `retryable`: se puede reintentar (red, 5xx, límite) o es definitivo. `credentials`: el token no sirve o no alcanza la Location. El mensaje NO lleva secretos. */
export class GhlError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly credentials = false,
  ) {
    super(message);
    this.name = 'GhlError';
  }
}

export interface GhlProvider {
  /** `none` = sin adaptador configurado. */
  readonly kind: 'none' | 'fake' | 'ghl';
  /** ¿Necesita las credenciales de la empresa para hablar con GHL? (`ghl` sí; el fake de pruebas no.) */
  readonly requiresCredentials: boolean;
  /** Comprueba que el token funciona y alcanza la Location. Devuelve el nombre de la Location si GHL lo informa. Lanza `GhlError`. */
  verify(credentials: GhlCredentials): Promise<{ name: string | null }>;
}

export const GHL_PROVIDER = Symbol('GHL_PROVIDER');

/** Sin adaptador configurado. */
export class NoGhlProvider implements GhlProvider {
  readonly kind = 'none' as const;
  readonly requiresCredentials = false;
  verify(): Promise<{ name: string | null }> {
    return Promise.reject(new GhlError('No hay adaptador de GoHighLevel configurado', false));
  }
}
