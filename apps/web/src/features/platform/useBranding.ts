import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, tokens } from '../../lib/api';

const KEY = ['platform', 'branding'] as const;

export interface BrandingView {
  has_favicon: boolean;
  /** Cambia en cada subida: sirve para ver siempre la imagen nueva. */
  version: string | null;
  content_type: string | null;
  bytes: number | null;
  px: number | null;
  updated_at: string | null;
}

/** Lo que el servidor exige del favicon (se vuelve a validar allá por su contenido real; esto solo evita subir archivos que ya se sabe que no sirven). */
export const FAVICON_MAX_BYTES = 256 * 1024;
export const FAVICON_ACCEPT = 'image/png,image/x-icon,image/vnd.microsoft.icon,image/webp,.png,.ico,.webp';

/** El tipo con el que se manda el archivo: el que dice el navegador o, si no dice nada, el de su extensión. El servidor no se fía de él (mira el contenido). */
export function faviconMime(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  const ext = file.name.toLowerCase().split('.').pop();
  return ext === 'png' ? 'image/png' : ext === 'ico' ? 'image/x-icon' : ext === 'webp' ? 'image/webp' : 'application/octet-stream';
}

/** Un motivo para no subir el archivo, o null si parece bien. */
export function faviconProblem(file: { name: string; type: string; size: number }): string | null {
  if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') return 'No se aceptan archivos SVG: sube una imagen PNG, ICO o WebP.';
  if (file.size === 0) return 'El archivo está vacío.';
  if (file.size > FAVICON_MAX_BYTES) return `El archivo pesa demasiado: el máximo es ${FAVICON_MAX_BYTES / 1024} KB.`;
  return null;
}

export function useBranding() {
  return useQuery({ queryKey: KEY, retry: false, queryFn: () => api<BrandingView>('/platform/branding') });
}

export function useUploadFavicon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<BrandingView> => {
      const res = await fetch('/v1/platform/branding/favicon', {
        method: 'PUT',
        headers: { 'content-type': faviconMime(file), 'x-requested-by': 'sales-smart-web', ...(tokens.get() ? { authorization: `Bearer ${tokens.get()}` } : {}) },
        body: await file.arrayBuffer(),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? `Error ${res.status}`);
      }
      return (await res.json()) as BrandingView;
    },
    onSuccess: (v) => { qc.setQueryData(KEY, v); },
  });
}

export function useClearFavicon() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api<BrandingView>('/platform/branding/favicon', { method: 'DELETE' }), onSuccess: (v) => { qc.setQueryData(KEY, v); } });
}

/** Cambia el icono de ESTA pestaña al instante (las demás lo verán cuando el navegador renueve su copia, hasta 5 minutos). */
export function refreshTabIcon(version: string | null): void {
  try {
    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
    if (link) link.href = `/v1/branding/favicon?v=${encodeURIComponent(version ?? 'default')}`;
  } catch {
    /* sin DOM utilizable: no pasa nada */
  }
}
