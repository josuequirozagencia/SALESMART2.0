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

/** Datos con que se busca o crea un contacto en GHL (se empareja por teléfono o correo, según la configuración de duplicados de la Location). */
export interface GhlContactInput {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface GhlProvider {
  /** `none` = sin adaptador configurado. */
  readonly kind: 'none' | 'fake' | 'ghl';
  /** ¿Necesita las credenciales de la empresa para hablar con GHL? (`ghl` sí; el fake de pruebas no.) */
  readonly requiresCredentials: boolean;
  /** Comprueba que el token funciona y alcanza la Location. Devuelve el nombre de la Location si GHL lo informa. Lanza `GhlError`. */
  verify(credentials: GhlCredentials): Promise<{ name: string | null }>;
  /** Agrega etiquetas a un contacto de GHL (idempotente: si ya las tiene no pasa nada). Lanza `GhlError`. */
  addTags(credentials: GhlCredentials, ghlContactId: string, tags: readonly string[]): Promise<void>;
  /** Quita etiquetas de un contacto de GHL (idempotente: si no las tiene no pasa nada). Lanza `GhlError`. */
  removeTags(credentials: GhlCredentials, ghlContactId: string, tags: readonly string[]): Promise<void>;
  /** Crea el contacto en GHL o actualiza el que ya coincide, y devuelve su identificador. Lanza `GhlError`. */
  upsertContact(credentials: GhlCredentials, input: GhlContactInput): Promise<{ id: string; created: boolean }>;
  /** Elimina de la Location la etiqueta con ese nombre (sin distinguir mayúsculas), con lo que desaparece de todos sus contactos. Si no existe no hace nada (`deleted: false`). Lanza `GhlError`. */
  deleteTag(credentials: GhlCredentials, name: string): Promise<{ deleted: boolean }>;
}

export const GHL_PROVIDER = Symbol('GHL_PROVIDER');

/** Sin adaptador configurado. */
export class NoGhlProvider implements GhlProvider {
  readonly kind = 'none' as const;
  readonly requiresCredentials = false;
  verify(): Promise<{ name: string | null }> {
    return Promise.reject(new GhlError('No hay adaptador de GoHighLevel configurado', false));
  }
  addTags(): Promise<void> {
    return Promise.reject(new GhlError('No hay adaptador de GoHighLevel configurado', false));
  }
  removeTags(): Promise<void> {
    return Promise.reject(new GhlError('No hay adaptador de GoHighLevel configurado', false));
  }
  upsertContact(): Promise<{ id: string; created: boolean }> {
    return Promise.reject(new GhlError('No hay adaptador de GoHighLevel configurado', false));
  }
  deleteTag(): Promise<{ deleted: boolean }> {
    return Promise.reject(new GhlError('No hay adaptador de GoHighLevel configurado', false));
  }
}
