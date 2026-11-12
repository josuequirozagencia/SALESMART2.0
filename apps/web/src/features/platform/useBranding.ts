import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, tokens } from '../../lib/api';
import { refreshBrand } from '../../lib/brand';

const KEY = ['platform', 'branding'] as const;

export interface BrandingFile { version: string; bytes: number; content_type: string; px: number | null }

/** Lo que ve el Súper Admin en Plataforma › Marca. */
export interface BrandingView {
  name: string | null;
  short_name: string | null;
  default_name: string;
  effective_name: string;
  icon: { custom: boolean; version: string | null; px: number | null; has_badge: boolean; updated_at: string | null };
  logo_light: BrandingFile | null;
  logo_dark: BrandingFile | null;
  updated_at: string | null;
}

/** Lo que el servidor exige de las imágenes (se vuelve a validar allá por su contenido real; esto solo evita subir archivos que ya se sabe que no sirven). */
export const IMAGE_MAX_BYTES = 1024 * 1024;
export const ICON_ACCEPT = 'image/png,.png';
export const LOGO_ACCEPT = 'image/png,image/webp,.png,.webp';

type FileLike = { name: string; type: string; size: number };

function commonProblem(file: FileLike): string | null {
  if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') return 'No se aceptan archivos SVG: pueden llevar scripts. Sube una imagen PNG.';
  if (file.size === 0) return 'El archivo está vacío.';
  if (file.size > IMAGE_MAX_BYTES) return `El archivo pesa demasiado: el máximo es ${IMAGE_MAX_BYTES / 1024 / 1024} MB.`;
  return null;
}

/** Un motivo para no subir el icono, o null si parece bien. */
export function iconProblem(file: FileLike): string | null {
  const c = commonProblem(file);
  if (c) return c;
  if (file.type !== 'image/png' && !/\.png$/i.test(file.name)) return 'El icono debe ser un PNG cuadrado de al menos 512 × 512 px.';
  return null;
}

/** Un motivo para no subir el logo, o null si parece bien. */
export function logoProblem(file: FileLike): string | null {
  const c = commonProblem(file);
  if (c) return c;
  if (!/^image\/(png|webp)$/.test(file.type) && !/\.(png|webp)$/i.test(file.name)) return 'El logo debe ser un PNG o un WebP.';
  return null;
}

export function useBranding() {
  return useQuery({ queryKey: KEY, retry: false, queryFn: () => api<BrandingView>('/platform/branding') });
}

/** Sube un archivo como cuerpo crudo (el servidor mira el contenido real, no el tipo que diga el navegador). */
async function putFile(path: string, file: File): Promise<BrandingView> {
  const res = await fetch(`/v1/platform/branding/${path}`, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-requested-by': 'sales-smart-web', ...(tokens.get() ? { authorization: `Bearer ${tokens.get()}` } : {}) },
    body: await file.arrayBuffer(),
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? `Error ${res.status}`);
  }
  return (await res.json()) as BrandingView;
}

/** Después de cada cambio: se guarda la vista nueva y se vuelve a leer la marca pública (título, logo e icono de ESTA pestaña cambian al instante). */
function useDone() {
  const qc = useQueryClient();
  return (v: BrandingView): void => {
    qc.setQueryData(KEY, v);
    void refreshBrand();
  };
}

export function useSetName() {
  const done = useDone();
  return useMutation({ mutationFn: (b: { name: string | null; short_name: string | null }) => api<BrandingView>('/platform/branding', { method: 'PUT', body: b }), onSuccess: done });
}

export function useUploadIcon() {
  const done = useDone();
  return useMutation({ mutationFn: (file: File) => putFile('icon', file), onSuccess: done });
}

export function useClearIcon() {
  const done = useDone();
  return useMutation({ mutationFn: () => api<BrandingView>('/platform/branding/icon', { method: 'DELETE' }), onSuccess: done });
}

export function useUploadLogo(which: 'light' | 'dark') {
  const done = useDone();
  return useMutation({ mutationFn: (file: File) => putFile(`logo-${which}`, file), onSuccess: done });
}

export function useClearLogo(which: 'light' | 'dark') {
  const done = useDone();
  return useMutation({ mutationFn: () => api<BrandingView>(`/platform/branding/logo-${which}`, { method: 'DELETE' }), onSuccess: done });
}
