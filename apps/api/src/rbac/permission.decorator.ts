import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from './catalog';

export const PERMISSION_KEY = 'ss:permissions';

/**
 * Exige TODOS los permisos indicados al principal autenticado. Se evalúa en el guard central (AccessGuard) con los
 * permisos que el resolvedor cargó de la BD para el rol verificado: la interfaz solo oculta, nunca protege.
 */
export const RequirePermission = (...keys: [PermissionKey, ...PermissionKey[]]) => SetMetadata(PERMISSION_KEY, keys);
