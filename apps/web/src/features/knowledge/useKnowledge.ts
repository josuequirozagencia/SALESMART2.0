import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, tokens, type ErrorDetail } from '../../lib/api';

export type DocStatus = 'pending' | 'processing' | 'ready' | 'error';
export type DocKind = 'txt' | 'csv' | 'pdf' | 'docx';

export interface KnowledgeDoc {
  id: string;
  name: string;
  kind: DocKind;
  size_bytes: number;
  status: DocStatus;
  /** Por qué falló o por qué espera (`waiting`, `no_credits`, `empty`…). */
  error_code: string | null;
  error_message: string | null;
  active: boolean;
  chunk_count: number;
  created_at: string;
  updated_at: string;
  can_reprocess: boolean;
}

export interface KnowledgePage {
  items: KnowledgeDoc[];
  next_cursor: string | null;
  limits: { max_bytes: number; max_documents: number; kinds: DocKind[]; chunks_used: number; chunks_max: number };
}

export interface SearchHit { document: { id: string; name: string }; content: string; score: number }

/** Cada cuánto se vuelve a mirar la lista mientras algún documento se está procesando o espera (el proceso es asíncrono). */
const POLL_MS = 5_000;

export function useKnowledgeDocs() {
  return useInfiniteQuery({
    queryKey: ['knowledge-docs'],
    retry: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<KnowledgePage>(`/knowledge/documents?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: (q) => ((q.state.data?.pages ?? []).some((p) => p.items.some((d) => d.status === 'pending' || d.status === 'processing')) ? POLL_MS : false),
  });
}

/** Sube un archivo tal cual (cuerpo crudo) con su nombre en `X-Filename`. */
export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<KnowledgeDoc> => {
      const res = await fetch('/v1/knowledge/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-requested-by': 'sales-smart-web', ...(tokens.get() ? { authorization: `Bearer ${tokens.get()}` } : {}) },
        body: await file.arrayBuffer(),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
        throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? `Error ${res.status}`, undefined, undefined, (body?.error?.details as ErrorDetail[]) ?? []);
      }
      return (await res.json()) as KnowledgeDoc;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['knowledge-docs'] }),
  });
}

export function useKnowledgeMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ['knowledge-docs'] });
  return {
    setActive: useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => api<KnowledgeDoc>(`/knowledge/documents/${id}`, { method: 'PATCH', body: { active } }), onSettled: done }),
    reprocess: useMutation({ mutationFn: (id: string) => api<KnowledgeDoc>(`/knowledge/documents/${id}/reprocess`, { method: 'POST' }), onSettled: done }),
    remove: useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/knowledge/documents/${id}`, { method: 'DELETE' }), onSettled: done }),
    search: useMutation({ mutationFn: (query: string) => api<{ hits: SearchHit[] }>('/knowledge/search', { method: 'POST', body: { query } }) }),
  };
}
