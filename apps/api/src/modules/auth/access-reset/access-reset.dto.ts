import { z } from 'zod';
import { REASON_MAX } from './access-reset.policy';

/**
 * Restablecer el acceso de una persona (ADR-71). `current_password` es la contraseña PROPIA de quien actúa (reautenticación). El motivo es opcional en el esquema porque su obligatoriedad
 * depende de quién actúa (agencia y Súper Admin sí): la decide el servicio. Estricto: nada más (ni el correo ni la contraseña de la persona afectada).
 */
export const accessResetSchema = z
  .object({
    current_password: z.string().min(1).max(200),
    reason: z.string().max(REASON_MAX + 200).optional(),
  })
  .strict();
export type AccessResetDto = z.infer<typeof accessResetSchema>;

export const listAccessResetsQuerySchema = z
  .object({
    /** Quién lo hizo. */
    actor_role: z.enum(['client_admin', 'agency', 'super_admin']).optional(),
    /** Solo los de esta empresa. */
    organization_id: z.uuid().optional(),
    /** Texto en el correo o nombre de quien lo hizo, en el correo enmascarado de la persona o en la empresa. */
    q: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ListAccessResetsQuery = z.infer<typeof listAccessResetsQuerySchema>;

export interface AccessResetResult {
  user_id: string;
  /** Cuántas sesiones se cerraron. */
  sessions_revoked: number;
  /** El correo de la persona, enmascarado (`an***@empresa.com`). */
  email_hint: string;
  /** false = el correo con el enlace NO salió (el proveedor falló): hay que repetirlo. */
  mail_sent: boolean;
  /** Administradores del cliente a los que se avisó (solo cuando actúa la agencia o el Súper Admin). */
  notified: number;
}

export interface AccessResetItem {
  id: string;
  actor: { email: string; name: string | null };
  actor_role: 'client_admin' | 'agency' | 'super_admin';
  actor_org: { id: string; name: string } | null;
  organization: { id: string; name: string } | null;
  target: { id: string; email_hint: string; name: string | null };
  reason: string | null;
  sessions_revoked: number;
  mail_sent: boolean;
  created_at: string;
}
export interface AccessResetList {
  items: AccessResetItem[];
  next_cursor: string | null;
}
