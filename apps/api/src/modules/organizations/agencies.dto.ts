import { z } from 'zod';

export const listAgenciesQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    state: z.enum(['active', 'suspended', 'invited']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.uuid().optional(),
  })
  .strict();
export type ListAgenciesQuery = z.infer<typeof listAgenciesQuerySchema>;

/**
 * Cambiar quién administra a un cliente (ADR-22): una agencia o `null` (administración directa). El motivo es opcional (no se pide por
 * ahora); el aviso al administrador del cliente va activado por defecto.
 */
export const assignAgencySchema = z
  .object({
    agency_id: z.uuid().nullable(),
    reason: z.string().trim().min(1).max(300).optional(),
    notify_client: z.boolean().default(true),
  })
  .strict();
export type AssignAgencyDto = z.infer<typeof assignAgencySchema>;

/** Nivel con el que el personal de la agencia entra a ESE cliente (ADR-11/41): lectura, asesor o administrador. «Sin acceso» = quitar al cliente de la cartera. */
export const setAgencyAccessSchema = z.object({ level: z.enum(['read', 'advisor', 'admin']) }).strict();
export type SetAgencyAccessDto = z.infer<typeof setAgencyAccessSchema>;

/** «Mis clientes» de la agencia: la cartera sale del contexto (nunca de la petición), así que solo hay búsqueda, estado y paginación. */
export const listAgencyClientsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100).optional(),
    state: z.enum(['trial', 'trial_expired', 'active', 'suspended', 'invited']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.uuid().optional(),
  })
  .strict();
export type ListAgencyClientsQuery = z.infer<typeof listAgencyClientsQuerySchema>;
