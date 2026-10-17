import { z } from 'zod';

const name = z.string().trim().min(1).max(60).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'debe ser un color hexadecimal, por ejemplo #6a44f2').transform((v) => v.toLowerCase());

/** Etiqueta personalizada nueva (M3.4, ADR-46). Las del sistema no se crean: las pone el sistema. */
export const createTagSchema = z.object({ name, color: color.default('#6a44f2') }).strict();
export type CreateTagDto = z.infer<typeof createTagSchema>;

export const updateTagSchema = z
  .object({ name: name.optional(), color: color.optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateTagDto = z.infer<typeof updateTagSchema>;

/** Etiquetas personalizadas de un contacto (alta y edición): reemplaza el conjunto; nunca incluye las del sistema. */
export const tagIdsSchema = z.array(z.uuid()).max(30).refine((a) => new Set(a).size === a.length, 'hay etiquetas repetidas');
