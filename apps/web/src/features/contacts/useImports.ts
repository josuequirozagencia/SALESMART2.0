import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiDownload, type Download } from '../../lib/api';
import type { ContactImport, ImportOptions, ImportPreview } from '../../lib/types';

/** Importaciones recientes (las últimas del servidor), para retomar una a medias o descargar su reporte. */
export function useImports(enabled: boolean) {
  return useQuery({ queryKey: ['contact-imports'], enabled, staleTime: 5_000, queryFn: async () => (await api<{ items: ContactImport[] }>('/contact-imports')).items });
}

export interface CreateImportInput {
  file_name: string;
  file_hash: string;
  total_rows: number;
  headers: string[];
  mapping: string[];
  options?: Partial<ImportOptions>;
}

export const createImport = (input: CreateImportInput): Promise<ContactImport> => api<ContactImport>('/contact-imports', { method: 'POST', body: input });
export const stageRows = (id: string, from: number, rows: string[][]): Promise<ContactImport> => api<ContactImport>(`/contact-imports/${id}/rows`, { method: 'POST', body: { from, rows } });
export const getImport = (id: string): Promise<ContactImport> => api<ContactImport>(`/contact-imports/${id}`);
export const previewImport = (id: string): Promise<ImportPreview> => api<ImportPreview>(`/contact-imports/${id}/preview`);
export const patchImport = (id: string, options: Partial<ImportOptions>): Promise<ContactImport> => api<ContactImport>(`/contact-imports/${id}`, { method: 'PATCH', body: { options } });
export const startImport = (id: string, legalBasis: boolean): Promise<ContactImport> => api<ContactImport>(`/contact-imports/${id}/start`, { method: 'POST', body: legalBasis ? { legal_basis: true } : {} });
export const processImport = (id: string): Promise<ContactImport> => api<ContactImport>(`/contact-imports/${id}/process`, { method: 'POST' });
export const cancelImport = (id: string): Promise<ContactImport> => api<ContactImport>(`/contact-imports/${id}/cancel`, { method: 'POST' });
export const importReport = (id: string): Promise<Download> => apiDownload(`/contact-imports/${id}/report`, { fallbackName: 'reporte-importacion.csv' });

/** Vista previa de la importación: se vuelve a pedir cuando cambian las opciones que la afectan (el prefijo de país). */
export function usePreview(id: string | null, prefix: string) {
  return useQuery({ queryKey: ['contact-imports', id, 'preview', prefix], enabled: id !== null, staleTime: 0, gcTime: 0, retry: false, queryFn: () => previewImport(id!) });
}

export function useCancelImport() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: cancelImport, onSettled: () => qc.invalidateQueries({ queryKey: ['contact-imports'] }) });
}

export interface ExportInput {
  scope: 'selection' | 'view' | 'all';
  ids?: string[];
  columns?: string[];
  q?: string;
  owner?: string;
  consent?: string;
  tag?: string[];
  cf?: string[];
  list?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}
export const exportContacts = (input: ExportInput): Promise<Download> => apiDownload('/contacts/export', { method: 'POST', body: input, fallbackName: 'contactos.csv' });
