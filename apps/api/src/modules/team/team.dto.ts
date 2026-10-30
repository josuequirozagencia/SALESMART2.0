import { z } from 'zod';
import type { PermissionKey } from '../../rbac';
import { email } from '../auth/signup/signup.dto';

const role = z.enum(['client_admin', 'advisor']);
/** Las claves se validan contra el catálogo en el servicio (con el motivo de cada una); aquí solo la forma. */
const keys = z.array(z.string().min(3).max(64)).max(80).default([]);
const permissions = z.object({ grant: keys, deny: keys }).strict();
const queueIds = z.array(z.uuid()).max(50).refine((a) => new Set(a).size === a.length, 'hay departamentos repetidos');

/** Invitar al equipo (M10.3, ADR-56): correo, rol y, si se quiere, los ajustes de permisos y los departamentos que se aplican al aceptar. */
export const inviteSchema = z.object({ email, role, permissions: permissions.optional(), queue_ids: queueIds.optional() }).strict();
export type InviteDto = z.infer<typeof inviteSchema>;

export const roleSchema = z.object({ role }).strict();
export type RoleDto = z.infer<typeof roleSchema>;

export const permissionsSchema = permissions;
export type PermissionsDto = z.infer<typeof permissionsSchema>;

export const departmentsSchema = z.object({ queue_ids: queueIds }).strict();
export type DepartmentsDto = z.infer<typeof departmentsSchema>;

/**
 * Qué hacer con las conversaciones abiertas de quien sale del equipo: SIN opción por omisión (decidido por el responsable): hay que elegir pasarlas a otra persona o dejarlas sin
 * asignación. Cuenta aunque la persona no tenga ninguna abierta.
 */
export const leaveSchema = z
  .object({ conversations: z.object({ action: z.enum(['transfer', 'unassign']), to_user_id: z.uuid().optional() }).strict() })
  .strict()
  .refine((b) => b.conversations.action === 'unassign' || b.conversations.to_user_id !== undefined, { path: ['conversations', 'to_user_id'], message: 'elige a quién pasarlas' })
  .refine((b) => b.conversations.action === 'transfer' || b.conversations.to_user_id === undefined, { path: ['conversations', 'to_user_id'], message: 'no se indica una persona si se dejan sin asignación' });
export type LeaveDto = z.infer<typeof leaveSchema>;

export type PermissionList = PermissionKey[];
