import { z } from 'zod';

/** Límites provisionales (ADR-47 #2). */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_COLUMNS = 60;
export const MAX_CELL_LENGTH = 1000;
export const IMPORT_BATCH = 200;

const target = z.string().regex(/^(?:ignore|name|phone|email|cf:[a-z][a-z0-9_]{0,39})$/, 'destino de columna no válido');

export const importOptionsShape = {
  /** Qué hacer con un teléfono que ya tiene contacto: omitir, o completar solo lo que le falta. */
  duplicates: z.enum(['skip', 'update_empty']),
  /** Prefijo de país para los números sin «+». */
  country_prefix: z.string().regex(/^\+[1-9]\d{0,3}$/),
  /** «Sin definir» por defecto; «con consentimiento» exige confirmar la base legal al empezar. */
  consent: z.enum(['unknown', 'granted']),
  tag_id: z.uuid().nullable(),
  owner_id: z.uuid().nullable(),
};
export const importOptionsSchema = z.object(importOptionsShape).strict();
export type ImportOptions = z.infer<typeof importOptionsSchema>;
export const DEFAULT_IMPORT_OPTIONS: ImportOptions = { duplicates: 'skip', country_prefix: '+593', consent: 'unknown', tag_id: null, owner_id: null };

/** Alta de la importación: el archivo ya fue leído por el navegador; aquí van su huella, sus encabezados, cómo se leen las columnas y las opciones. */
export const createImportSchema = z
  .object({
    file_name: z.string().trim().min(1).max(200).refine((v) => !/\p{Cc}/u.test(v), 'caracteres no permitidos'),
    file_hash: z.string().regex(/^[0-9a-f]{64}$/, 'debe ser un SHA-256 en hexadecimal'),
    total_rows: z.number().int().min(1).max(MAX_IMPORT_ROWS),
    headers: z.array(z.string().max(200)).min(1).max(MAX_IMPORT_COLUMNS),
    mapping: z.array(target).min(1).max(MAX_IMPORT_COLUMNS),
    options: z.object(importOptionsShape).partial().strict().default({}),
  })
  .strict()
  .refine((b) => b.headers.length === b.mapping.length, { path: ['mapping'], message: 'debe haber un destino por cada columna' })
  .refine((b) => b.mapping.filter((m) => m === 'phone').length === 1, { path: ['mapping'], message: 'elige exactamente una columna para el teléfono' })
  .refine((b) => b.mapping.filter((m) => m !== 'ignore').length === new Set(b.mapping.filter((m) => m !== 'ignore')).size, { path: ['mapping'], message: 'hay dos columnas con el mismo destino' });
export type CreateImportDto = z.infer<typeof createImportSchema>;

/** Un lote de filas: `from` es el número (desde 1) de la primera; deben llegar en orden y sin huecos. */
export const stageRowsSchema = z
  .object({ from: z.number().int().min(1).max(MAX_IMPORT_ROWS), rows: z.array(z.array(z.string().max(MAX_CELL_LENGTH)).max(MAX_IMPORT_COLUMNS)).min(1).max(IMPORT_BATCH) })
  .strict();
export type StageRowsDto = z.infer<typeof stageRowsSchema>;

export const patchImportSchema = z
  .object({ options: z.object(importOptionsShape).partial().strict() })
  .strict()
  .refine((b) => Object.keys(b.options).length > 0, { message: 'no hay nada que cambiar' });
export type PatchImportDto = z.infer<typeof patchImportSchema>;

/** Empezar. `legal_basis` es obligatorio (true) cuando se importa «con consentimiento». */
export const startImportSchema = z.object({ legal_basis: z.boolean().optional() }).strict();
export type StartImportDto = z.infer<typeof startImportSchema>;
