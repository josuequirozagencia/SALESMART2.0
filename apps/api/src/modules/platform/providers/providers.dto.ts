import { z } from 'zod';

/** Clave de servicio, proveedor o campo del catálogo (minúsculas, dígitos y guion bajo). */
export const catalogKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'clave no válida');

/** Elegir el proveedor ACTIVO de un servicio (`null` = ninguno). */
export const setActiveSchema = z.object({ provider: catalogKey.nullable() }).strict();
export type SetActiveDto = z.infer<typeof setActiveSchema>;

/**
 * Guardar credenciales de un proveedor. Es un CAMBIO PARCIAL: solo se tocan los campos enviados.
 *  - values: valores nuevos (reemplazan al anterior; todos se guardan cifrados y jamás se leen de vuelta).
 *  - clear: campos a quitar.
 * El servidor valida cada clave y valor contra el catálogo; aquí solo la forma.
 */
export const saveCredentialsSchema = z
  .object({
    values: z.record(catalogKey, z.string().max(2000)).optional(),
    clear: z.array(catalogKey).max(20).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b.values ?? {}).length + (b.clear?.length ?? 0) > 0, { message: 'no hay nada que guardar' })
  .refine((b) => Object.keys(b.values ?? {}).length <= 20, { message: 'demasiados campos' });
export type SaveCredentialsDto = z.infer<typeof saveCredentialsSchema>;
