import { isUuid } from '@sales-smart/shared';
import { InvalidContextError, MissingPlatformContextError } from './errors';
import { platformStorage, TenantContext } from './tenant-context';

/** Contexto de operaciones de plataforma (solo super admin). Mutuamente excluyente con TenantContext. */
export interface PlatformData {
  readonly actorUserId: string;
  readonly role: 'super_admin';
  readonly requestId: string;
}

export const PlatformContext = {
  run<T>(input: { actorUserId: string; requestId?: string }, fn: () => T): T {
    if (platformStorage.getStore() !== undefined) throw new InvalidContextError('PlatformContext ya activo (no se permite anidar)');
    if (TenantContext.currentOrNull() !== null) throw new InvalidContextError('TenantContext activo (mutuamente excluyentes)');
    if (!isUuid(input.actorUserId)) throw new InvalidContextError('actorUserId no es un UUID');
    const data: PlatformData = Object.freeze({
      actorUserId: input.actorUserId.toLowerCase(),
      role: 'super_admin' as const,
      requestId: input.requestId ?? crypto.randomUUID(),
    });
    return platformStorage.run(data, fn);
  },
  current(): PlatformData {
    const c = platformStorage.getStore();
    if (c === undefined) throw new MissingPlatformContextError();
    return c as PlatformData;
  },
  currentOrNull(): PlatformData | null {
    return (platformStorage.getStore() as PlatformData | undefined) ?? null;
  },
};
