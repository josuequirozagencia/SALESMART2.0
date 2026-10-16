import { z } from 'zod';
import { ACTIVE_ENTITIES, FIELD_TYPES, MAX_OPTIONS, MAX_OPTION_LENGTH } from './field-types';

const entity = z.enum(ACTIVE_ENTITIES);
const name = z.string().trim().min(1).max(80).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');
// Las opciones se limpian y validan en el servicio (vacías, repetidas…); aquí solo se acota el tamaño de lo que entra
const options = z.array(z.string().max(MAX_OPTION_LENGTH + 50)).max(MAX_OPTIONS + 20);

/** Alta de un campo personalizado. La variable (`key`) NO se envía: la genera el servidor desde el nombre y no cambia nunca. */
export const createFieldSchema = z
  .object({
    entity: entity.default('contact'),
    name,
    type: z.enum(FIELD_TYPES),
    options: options.optional(),
    required: z.boolean().default(false),
    show_in_form: z.boolean().default(true),
  })
  .strict();
export type CreateFieldDto = z.infer<typeof createFieldSchema>;

/** Cambio PARCIAL. El tipo y la variable no se pueden cambiar. */
export const updateFieldSchema = z
  .object({
    name: name.optional(),
    options: options.optional(),
    required: z.boolean().optional(),
    show_in_form: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateFieldDto = z.infer<typeof updateFieldSchema>;

/** Orden completo de los campos ACTIVOS de una entidad. */
export const orderFieldsSchema = z
  .object({
    entity: entity.default('contact'),
    ids: z.array(z.uuid()).min(1).max(100).refine((a) => new Set(a).size === a.length, 'hay ids repetidos'),
  })
  .strict();
export type OrderFieldsDto = z.infer<typeof orderFieldsSchema>;

export const listFieldsQuerySchema = z
  .object({
    entity: entity.default('contact'),
    archived: z.literal('include').optional(),
  })
  .strict();
export type ListFieldsQuery = z.infer<typeof listFieldsQuerySchema>;

/**
 * Valores de campos personalizados dentro de un contacto: `{ <variable>: valor }`. Aquí solo se acota la forma y el tamaño; el valor se valida contra
 * la definición de cada campo en el servicio. `null` (o texto vacío / lista vacía) vacía el valor.
 */
export const customFieldValuesSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'variable no válida'),
    z.union([z.string().max(5000), z.number(), z.boolean(), z.array(z.string().max(MAX_OPTION_LENGTH + 50)).max(MAX_OPTIONS), z.null()]),
  )
  .refine((o) => Object.keys(o).length <= 60, 'demasiados campos');
export type CustomFieldValuesInput = z.infer<typeof customFieldValuesSchema>;
