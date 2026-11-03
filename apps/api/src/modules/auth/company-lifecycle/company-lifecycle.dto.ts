import { z } from 'zod';

/**
 * Eliminar una empresa (F3, ADR-59 #1): la contraseña del Súper Admin, el nombre exacto de la empresa y el motivo. Ninguno se interpreta: la contraseña se compara con el hash,
 * el nombre con el de la empresa y el motivo es solo texto para la auditoría.
 */
export const deleteCompanySchema = z.strictObject({
  password: z.string().min(1).max(200),
  confirm_name: z.string().min(1).max(200),
  reason: z.string().trim().min(10, 'Cuéntanos el motivo (mínimo 10 caracteres)').max(300),
});
export type DeleteCompanyDto = z.infer<typeof deleteCompanySchema>;

/** Recuperar una empresa eliminada: solo la contraseña del Súper Admin (ADR-59 #6). */
export const recoverCompanySchema = z.strictObject({
  password: z.string().min(1).max(200),
});
export type RecoverCompanyDto = z.infer<typeof recoverCompanySchema>;

export const uuidParam = z.uuid();
