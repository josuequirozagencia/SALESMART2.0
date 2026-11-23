import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, tokens, type ErrorDetail } from '../../lib/api';

export type AssetKind = 'image' | 'video' | 'audio' | 'document';

export interface LibraryAsset {
  id: string;
  name: string;
  description: string | null;
  kind: AssetKind;
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
export interface LibraryFolder { id: string; name: string; asset_count: number }
export interface LibraryUsage { used_bytes: number; quota_bytes: number; available_bytes: number; assets: number }
export interface LibraryPage {
  folders: LibraryFolder[];
  items: LibraryAsset[];
  next_cursor: string | null;
  /** Solo para quien administra. */
  usage: LibraryUsage | null;
  access: { manage: boolean };
  storage_available: boolean;
}

/** Qué se está mirando: todas las carpetas, la raíz o una carpeta; con búsqueda y tipo. */
export interface LibraryFilter { folder: 'all' | 'root' | string; q: string; kind: '' | AssetKind; archived?: boolean }

const params = (f: LibraryFilter, cursor?: string): string => {
  const p = new URLSearchParams({ limit: '30' });
  if (f.folder !== 'all') p.set('folder_id', f.folder);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.kind) p.set('kind', f.kind);
  if (f.archived) p.set('state', 'archived');
  if (cursor) p.set('cursor', cursor);
  return p.toString();
};

/** La biblioteca con filtros y «Ver más». La primera página trae las carpetas y, para quien administra, el espacio usado. */
export function useLibrary(filter: LibraryFilter) {
  return useInfiniteQuery({
    queryKey: ['library', filter],
    retry: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<LibraryPage>(`/library?${params(filter, pageParam)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

/**
 * ¿La persona puede ver la biblioteca? Una consulta mínima compartida por el menú y el chat: si el servidor responde, hay acceso (y `manage` dice si además administra); si no (403), no hay botón ni
 * sección. No replica la matriz de permisos.
 */
export function useLibraryAccess() {
  return useQuery({ queryKey: ['library-access'], retry: false, staleTime: 5 * 60_000, queryFn: () => api<LibraryPage>('/library?limit=1').then((p) => p.access) });
}

/** Qué automatizaciones adjuntan un archivo (para avisar antes de archivarlo). */
export function useAssetUsage(id: string) {
  return useQuery({ queryKey: ['library-usage', id], retry: false, staleTime: 0, queryFn: () => api<{ automations: Array<{ id: string; name: string; status: string }> }>(`/library/assets/${id}/usage`) });
}

/** Una dirección firmada de pocos minutos para ver o descargar el archivo. */
export const assetUrl = (id: string): Promise<{ url: string; expires_at: string; kind: string; mime_type: string; name: string }> => api(`/library/assets/${id}/url`);

/** La miniatura (imágenes): se pide la dirección firmada y se vuelve a pedir antes de que venza. */
export function useAssetThumb(asset: LibraryAsset, enabled = true) {
  return useQuery({ queryKey: ['library-url', asset.id], enabled: enabled && asset.kind === 'image', retry: false, staleTime: 4 * 60_000, queryFn: () => assetUrl(asset.id) });
}

function useDone() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['library'] }), qc.invalidateQueries({ queryKey: ['library-access'] })]);
}

/** Sube un archivo tal cual (cuerpo crudo) con su nombre en `X-Filename`; con `folderId` queda en esa carpeta. */
export function useUploadAsset() {
  const done = useDone();
  return useMutation({
    mutationFn: async ({ file, folderId }: { file: File; folderId?: string | undefined }): Promise<LibraryAsset> => {
      const q = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : '';
      const res = await fetch(`/v1/library/assets${q}`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-requested-by': 'sales-smart-web', ...(tokens.get() ? { authorization: `Bearer ${tokens.get()}` } : {}) },
        body: await file.arrayBuffer(),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
        throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? `Error ${res.status}`, undefined, undefined, (body?.error?.details as ErrorDetail[]) ?? []);
      }
      return (await res.json()) as LibraryAsset;
    },
    onSettled: done,
  });
}

export interface AssetChanges { name?: string; description?: string | null; folder_id?: string | null; usable_by_advisors?: boolean; usable_by_ai?: boolean }

export function useLibraryMutations() {
  const done = useDone();
  return {
    update: useMutation({ mutationFn: ({ id, changes }: { id: string; changes: AssetChanges }) => api<LibraryAsset>(`/library/assets/${id}`, { method: 'PATCH', body: changes }), onSettled: done }),
    archive: useMutation({ mutationFn: (id: string) => api<LibraryAsset>(`/library/assets/${id}/archive`, { method: 'POST' }), onSettled: done }),
    createFolder: useMutation({ mutationFn: (name: string) => api<LibraryFolder>('/library/folders', { method: 'POST', body: { name } }), onSettled: done }),
    renameFolder: useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api<LibraryFolder>(`/library/folders/${id}`, { method: 'PATCH', body: { name } }), onSettled: done }),
    archiveFolder: useMutation({ mutationFn: (id: string) => api<{ id: string; archived: true }>(`/library/folders/${id}/archive`, { method: 'POST' }), onSettled: done }),
  };
}

/** Envía un archivo de la biblioteca a una conversación (el servidor lo copia a un adjunto propio y lo manda como un archivo normal). */
export function useSendLibraryAsset(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ assetId, caption }: { assetId: string; caption?: string }) => api<unknown>(`/conversations/${conversationId}/library/${assetId}/send`, { method: 'POST', body: caption ? { caption } : {} }),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['conversation', conversationId] }), qc.invalidateQueries({ queryKey: ['messages', conversationId] }), qc.invalidateQueries({ queryKey: ['conversations'] })]),
  });
}

export const KIND_LABEL: Record<AssetKind, string> = { image: 'Imagen', video: 'Video', audio: 'Audio', document: 'Documento' };

/** «1,2 MB» / «340 KB» para el peso de un archivo. */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
