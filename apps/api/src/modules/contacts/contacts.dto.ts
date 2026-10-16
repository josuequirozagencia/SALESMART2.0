import { z } from 'zod';
import { customFieldValuesSchema } from '../custom-fields';

const name = z.string().trim().min(1).max(200).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos');
const email = z.string().trim().max(254).pipe(z.email()).transform((v) => v.toLowerCase());
/** Teléfono en E.164: «+», un primer dígito 1-9 y de 8 a 15 dígitos en total. La web arma el número con el prefijo del país. */
const phone = z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'debe estar en formato internacional, por ejemplo +593987654321');
/** Hasta 5 teléfonos; el PRIMERO es el principal. Sin repetidos. */
const phones = z.array(phone).max(5).refine((a) => new Set(a).size === a.length, 'hay teléfonos repetidos');
const consent = z.enum(['unknown', 'granted', 'revoked']);

/**
 * Alta manual de un contacto (ADR-32 #3). El origen NO se envía: es «manual». Sin `contacts.view_all` el contacto queda asignado a quien lo crea
 * y enviar otro dueño es un 403. El servidor valida siempre; la web solo ayuda.
 */
export const createContactSchema = z
  .object({
    name,
    email: email.nullable().optional(),
    phones: phones.optional(),
    owner_id: z.uuid().nullable().optional(),
    consent: consent.optional(),
    /** Campos personalizados (M3.2, ADR-44): `{ variable: valor }`. Se validan contra la definición de cada campo; los obligatorios deben venir. */
    custom_fields: customFieldValuesSchema.optional(),
  })
  .strict();
export type CreateContactDto = z.infer<typeof createContactSchema>;

/** Cambio PARCIAL: solo se tocan los campos enviados. `phones` reemplaza la lista completa. Cambiar el dueño exige `contacts.view_all`. */
export const updateContactSchema = z
  .object({
    name: name.optional(),
    email: email.nullable().optional(),
    phones: phones.optional(),
    owner_id: z.uuid().nullable().optional(),
    consent: consent.optional(),
    /** Solo se tocan las variables enviadas; `null` vacía el valor. */
    custom_fields: customFieldValuesSchema.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'no hay nada que cambiar' });
export type UpdateContactDto = z.infer<typeof updateContactSchema>;

export const SORTS = ['created_at', 'updated_at', 'name'] as const;
export type ContactSort = (typeof SORTS)[number];

/** `owner`: «me» (míos), «none» (sin asignar) o el id de una persona. Sin `contacts.view_all` se ignora: el alcance ya es propio. */
export const listContactsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    owner: z.union([z.literal('me'), z.literal('none'), z.uuid()]).optional(),
    source: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/).optional(),
    sort: z.enum(SORTS).default('created_at'),
    order: z.enum(['asc', 'desc']).default('desc'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(300).optional(),
  })
  .strict();
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
