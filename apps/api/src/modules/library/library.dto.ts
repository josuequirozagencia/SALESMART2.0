import { z } from 'zod';

/** Texto de una sola línea, sin caracteres de control, recortado. */
const line = (max: number) => z.string().transform((s) => s.replace(/\p{Cc}/gu, '').trim()).pipe(z.string().min(1).max(max));

export const listLibraryQuerySchema = z
  .object({
    /** `root` = los de la raíz (sin carpeta); un id = los de esa carpeta; sin él, todos. */
    folder_id: z.union([z.literal('root'), z.uuid()]).optional(),
    q: z.string().trim().max(80).optional(),
    kind: z.enum(['image', 'video', 'audio', 'document']).optional(),
    /** Solo quien administra ve los archivados. */
    state: z.enum(['ready', 'archived']).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ListLibraryQuery = z.infer<typeof listLibraryQuerySchema>;

/** La subida lleva el archivo como cuerpo; lo demás va en la dirección. */
export const uploadAssetQuerySchema = z
  .object({
    name: line(200).optional(),
    description: z.string().trim().max(300).optional(),
    folder_id: z.uuid().optional(),
  })
  .strict();
export type UploadAssetQuery = z.infer<typeof uploadAssetQuerySchema>;

export const updateAssetSchema = z
  .object({
    name: line(200).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    folder_id: z.uuid().nullable().optional(),
    usable_by_advisors: z.boolean().optional(),
    usable_by_ai: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'No hay nada que cambiar' });
export type UpdateAssetDto = z.infer<typeof updateAssetSchema>;

export const folderSchema = z.object({ name: line(80) }).strict();
export type FolderDto = z.infer<typeof folderSchema>;

export interface AssetView {
  id: string;
  name: string;
  description: string | null;
  kind: 'image' | 'video' | 'audio' | 'document';
  mime_type: string;
  size_bytes: number;
  folder_id: string | null;
  usable_by_advisors: boolean;
  usable_by_ai: boolean;
  state: 'ready' | 'archived';
  /** `skipped` = sin antivirus (sin revisar). */
  scan_status: 'clean' | 'skipped';
  created_at: string;
  archived_at: string | null;
}

export interface FolderView {
  id: string;
  name: string;
  /** Archivos vigentes que la persona ve en la carpeta. */
  asset_count: number;
}

export interface UsageView {
  used_bytes: number;
  quota_bytes: number;
  available_bytes: number;
  assets: number;
}
