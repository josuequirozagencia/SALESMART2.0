import { useMemo } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, tokens, type ErrorDetail } from '../../lib/api';

export interface PhotosReply {
  contacts: Record<string, string>;
  users: Record<string, string>;
}
const CHUNK = 50;
const EMPTY: PhotosReply = { contacts: {}, users: {} };

/**
 * Las fotos de lo que la pantalla muestra (v5): una consulta por lotes de 50 contactos (más las personas en la primera). El servidor da URL firmadas de 15 min y solo de lo que existe y la persona puede ver;
 * lo que no aparece se muestra con siglas. Un fallo de la consulta no se avisa: es un adorno, no un dato. Los lotes se arman por orden de aparición para que cargar más conversaciones no repita los anteriores.
 */
export function usePhotos(contactIds: readonly string[], userIds: readonly string[]): { contact: (id: string) => string | undefined; user: (id: string) => string | undefined } {
  // Llaves de texto: el gancho solo recalcula cuando cambia el contenido, no la identidad del arreglo que se pasa
  const contactKey = [...new Set(contactIds)].join(',');
  const userKey = [...new Set(userIds)].slice(0, CHUNK).join(',');
  const chunks = useMemo(() => {
    const contacts = contactKey === '' ? [] : contactKey.split(',');
    const users = userKey === '' ? [] : userKey.split(',');
    const out: Array<{ contacts: string[]; users: string[] }> = [];
    for (let i = 0; i < Math.max(contacts.length, 1); i += CHUNK) out.push({ contacts: contacts.slice(i, i + CHUNK), users: i === 0 ? users : [] });
    return out.filter((c) => c.contacts.length > 0 || c.users.length > 0);
  }, [contactKey, userKey]);
  const results = useQueries({
    queries: chunks.map((c) => ({
      queryKey: ['photos', c.contacts.join(','), c.users.join(',')],
      queryFn: () => api<PhotosReply>(`/photos?contacts=${c.contacts.join(',')}&users=${c.users.join(',')}`),
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });
  const merged = useMemo(() => {
    const m: PhotosReply = { contacts: {}, users: {} };
    for (const r of results) {
      const d = r.data ?? EMPTY;
      Object.assign(m.contacts, d.contacts);
      Object.assign(m.users, d.users);
    }
    return m;
  }, [results]);
  return { contact: (id) => merged.contacts[id], user: (id) => merged.users[id] };
}

const ME = ['me-photo'] as const;

/** La foto de la persona de la sesión en esta empresa: verla, subirla (el archivo tal cual, hasta 2 MB) y quitarla. */
export function useMyPhoto() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ME, queryFn: () => api<{ photo_url: string | null }>('/me/photo'), staleTime: 10 * 60_000, retry: false });
  const done = (): void => {
    void qc.invalidateQueries({ queryKey: ME });
    void qc.invalidateQueries({ queryKey: ['photos'] });
  };
  const upload = useMutation({
    mutationFn: async (file: File): Promise<{ photo_url: string | null }> => {
      const res = await fetch('/v1/me/photo', {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-requested-by': 'sales-smart-web', ...(tokens.get() ? { authorization: `Bearer ${tokens.get()}` } : {}) },
        body: await file.arrayBuffer(),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
        throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? `Error ${res.status}`, undefined, undefined, (body?.error?.details as ErrorDetail[]) ?? []);
      }
      return (await res.json()) as { photo_url: string | null };
    },
    onSettled: done,
  });
  const remove = useMutation({ mutationFn: () => api<{ photo_url: null }>('/me/photo', { method: 'DELETE' }), onSettled: done });
  return { photo: q.data?.photo_url ?? null, loading: q.isPending, upload, remove };
}
