import { AsyncLocalStorage } from 'node:async_hooks';
import { isUuid } from '@sales-smart/shared';
import { InvalidContextError, MissingTenantContextError } from './errors';

/**
 * Datos del contexto de organización. Inmutables. La organización sale SIEMPRE de la sesión autenticada
 * (nunca del body/query/headers — ADR-24 P5). El código de negocio NO recibe organizationId como
 * parámetro: lo lee la capa de datos desde aquí (ADR-24 P4).
 */
export interface TenantData {
  readonly organizationId: string;
  readonly userId?: string;
  /**
   * `organizationId` es SIEMPRE la organización efectiva (la que usa RLS).
   * Operación de soporte: si un super admin / agencia actúa DENTRO de esa organización, `actingAs` lo declara
   * (para auditoría) y `actingOrgId` es la organización de origen del actor (p. ej. la agencia), si tiene una.
   */
  readonly actingAs?: 'super_admin' | 'agency';
  readonly actingOrgId?: string;
  readonly requestId: string;
}

export type TenantInput = Omit<TenantData, 'requestId'> & { requestId?: string };

export const platformStorage = new AsyncLocalStorage<unknown>();
const storage = new AsyncLocalStorage<TenantData>();

function validate(input: TenantInput): TenantData {
  if (!isUuid(input.organizationId)) throw new InvalidContextError('organizationId no es un UUID');
  if (input.userId !== undefined && !isUuid(input.userId)) throw new InvalidContextError('userId no es un UUID');
  if (input.actingOrgId !== undefined && !isUuid(input.actingOrgId)) throw new InvalidContextError('actingOrgId no es un UUID');
  if (input.actingAs !== undefined && input.actingAs !== 'super_admin' && input.actingAs !== 'agency') {
    throw new InvalidContextError('actingAs inválido');
  }
  if (input.actingOrgId !== undefined && input.actingAs === undefined) {
    throw new InvalidContextError('actingOrgId requiere actingAs');
  }
  const requestId = input.requestId ?? crypto.randomUUID();
  return Object.freeze({ ...input, organizationId: input.organizationId.toLowerCase(), requestId });
}

export const TenantContext = {
  /** Ejecuta `fn` dentro del contexto. Anidar contextos (incluso del mismo tenant) está prohibido. */
  run<T>(input: TenantInput, fn: () => T): T {
    if (storage.getStore() !== undefined) throw new InvalidContextError('TenantContext ya activo (no se permite anidar)');
    if (platformStorage.getStore() !== undefined) throw new InvalidContextError('PlatformContext activo (mutuamente excluyentes)');
    return storage.run(validate(input), fn);
  },
  /** Contexto actual; lanza si no existe. */
  current(): TenantData {
    const c = storage.getStore();
    if (c === undefined) throw new MissingTenantContextError();
    return c;
  },
  currentOrNull(): TenantData | null {
    return storage.getStore() ?? null;
  },
};
