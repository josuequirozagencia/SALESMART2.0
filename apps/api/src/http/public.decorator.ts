import { SetMetadata } from '@nestjs/common';

export type AccessKind = 'public' | 'tenant' | 'platform' | 'self';
export const ACCESS_KEY = 'ss:access';

/**
 * Toda ruta es de tenant por defecto (DENEGAR por defecto). Marcar explícitamente:
 *  - @Public(): no requiere autenticación ni toca datos de negocio (salud, login...).
 *  - @SelfService(): cualquier principal autenticado (tenant o plataforma) operando SOLO sobre su propio usuario
 *    (p. ej. cambiar su contraseña). No toca datos de negocio ni acepta ids de usuario/organización de la petición.
 *  - @PlatformOnly(): operaciones de plataforma (solo super_admin sin organización activa).
 */
export const Public = () => SetMetadata(ACCESS_KEY, 'public' satisfies AccessKind);
export const PlatformOnly = () => SetMetadata(ACCESS_KEY, 'platform' satisfies AccessKind);
export const SelfService = () => SetMetadata(ACCESS_KEY, 'self' satisfies AccessKind);
