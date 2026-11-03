import { z } from 'zod';

/** Pedir la copia completa de una empresa eliminada desde la Consola (F3b, ADR-59 #8): la contraseña del Súper Admin. */
export const requestExportSchema = z.strictObject({ password: z.string().min(1).max(200) });
export type RequestExportDto = z.infer<typeof requestExportSchema>;

const part = z.number().int().min(1).max(999);

/** Bajar una parte del paquete (Consola): la sesión del Súper Admin basta; solo se dice cuál parte. */
export const downloadPartSchema = z.strictObject({ part });
export type DownloadPartDto = z.infer<typeof downloadPartSchema>;

const token = z.string().min(20).max(200);

/** Las páginas públicas del dueño (enlace de su correo): el token viaja en el cuerpo, nunca en la dirección. */
export const tokenSchema = z.strictObject({ token });
export type TokenDto = z.infer<typeof tokenSchema>;

export const tokenPasswordSchema = z.strictObject({ token, password: z.string().min(1).max(200) });
export type TokenPasswordDto = z.infer<typeof tokenPasswordSchema>;

export const tokenDownloadSchema = z.strictObject({ token, password: z.string().min(1).max(200), part });
export type TokenDownloadDto = z.infer<typeof tokenDownloadSchema>;

export const uuidParam = z.uuid();
