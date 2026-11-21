import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** Lo que la plataforma sabe de un anuncio de Meta (v20, ADR-55): titular, texto, dirección, red y la dirección firmada de la miniatura (dura 15 min). */
export interface AdCreative {
  source_id: string;
  headline: string | null;
  body: string | null;
  source_url: string | null;
  platform: 'facebook' | 'instagram' | null;
  thumbnail_url: string | null;
}

/**
 * Los anuncios (por id) que una pantalla muestra: hasta 50, sin repetidos. Sin ids no pide nada. Se vuelve a pedir pasados 10 minutos, antes de que caduquen las direcciones firmadas de las miniaturas. Si falla, la
 * pantalla sigue con lo que ya tiene (sin imagen).
 */
export function useAdCreatives(ids: ReadonlyArray<string | null | undefined>) {
  const clean = [...new Set(ids.filter((x): x is string => typeof x === 'string' && x !== ''))].sort().slice(0, 50);
  return useQuery({
    queryKey: ['ad-creatives', clean],
    enabled: clean.length > 0,
    retry: false,
    staleTime: 10 * 60_000,
    queryFn: () => api<{ items: Record<string, AdCreative> }>(`/ads/creatives?ids=${encodeURIComponent(clean.join(','))}`),
  });
}
