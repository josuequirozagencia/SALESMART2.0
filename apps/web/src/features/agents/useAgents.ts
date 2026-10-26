import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, tokens, type ErrorDetail } from '../../lib/api';

export type Cover = 'violet' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'rose' | 'slate';

export interface AgentCard {
  id: string;
  name: string;
  role: string | null;
  /** URL firmada de la foto (vale unos minutos); null si no tiene. */
  photo_url: string | null;
  cover: Cover;
  active: boolean;
  model: string;
  channels: Array<{ id: string; name: string }>;
  documents: number;
  chunks: number;
  created_at: string;
}

export interface Agent extends AgentCard {
  temperature: number;
  max_tokens: number;
  max_chars: number;
  personality: string;
  objective: string;
  extra_info: string;
  show_source: boolean;
  split_enabled: boolean;
  split_blocks: number;
  transfer_enabled: boolean;
  transfer_queue_id: string | null;
  always_on: boolean;
  document_ids: string[];
  channel_ids: string[];
  readiness: { instructions: boolean; documents: boolean; channel: boolean };
  updated_at: string;
}

export interface AgentOptions {
  models: string[];
  covers: Cover[];
  limits: { max_agents: number; max_photo_bytes: number; max_chunks: number };
  variables: Array<{ key: string; label: string; example: string; kind: 'builtin' | 'custom' }>;
  channels: Array<{ id: string; name: string; provider: string; status: string; agent: { id: string; name: string } | null }>;
  queues: Array<{ id: string; name: string }>;
  documents: Array<{ id: string; name: string; status: string; chunk_count: number; active: boolean }>;
}

export interface AgentPreview { system: string; missing: string[]; unknown: string[]; contact: { id: string; name: string } | null }

/** Un turno del simulador: lo que respondería el agente y «qué hizo». */
export interface TestTurn {
  replies: string[];
  trace: {
    search: { query: string; grounded: boolean; results: Array<{ document: string; score: number }> };
    missing_variables: string[];
    model: { name: string; tokens_in: number; tokens_out: number };
    split: boolean;
    trimmed: boolean;
  };
  credits_used: number;
  remaining_today: number;
  contact: { id: string; name: string } | null;
}

export type AgentPatch = Partial<{
  name: string;
  role: string | null;
  cover: Cover;
  active: boolean;
  model: string;
  temperature: number;
  max_tokens: number;
  max_chars: number;
  personality: string;
  objective: string;
  extra_info: string;
  show_source: boolean;
  split_enabled: boolean;
  split_blocks: number;
  transfer_enabled: boolean;
  transfer_queue_id: string | null;
  always_on: boolean;
}>;

export function useAgents() {
  return useQuery({ queryKey: ['agents'], retry: false, queryFn: () => api<{ items: AgentCard[]; limits: { max_agents: number } }>('/agents') });
}

export function useAgent(id: string) {
  return useQuery({ queryKey: ['agent', id], retry: false, queryFn: () => api<Agent>(`/agents/${id}`) });
}

export function useAgentOptions() {
  return useQuery({ queryKey: ['agent-options'], retry: false, queryFn: () => api<AgentOptions>('/agents/options') });
}

/** Los contactos que coinciden con la búsqueda (para probar las variables con uno real). Sin texto no busca. */
export function useContactSearch(q: string) {
  return useQuery({ queryKey: ['agent-contact-search', q], enabled: q.trim().length >= 2, retry: false, queryFn: () => api<{ items: Array<{ id: string; name: string }> }>(`/contacts?limit=6&q=${encodeURIComponent(q.trim())}`) });
}

export function useAgentMutations() {
  const qc = useQueryClient();
  const done = (id?: string) => async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['agents'] }), qc.invalidateQueries({ queryKey: ['agent-options'] }), id ? qc.invalidateQueries({ queryKey: ['agent', id] }) : Promise.resolve()]);
  };
  const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
  return {
    create: useMutation({ mutationFn: (b: { name: string; role?: string | null; cover?: Cover }) => api<Agent>('/agents', { method: 'POST', body: b }), onSettled: done() }),
    update: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: AgentPatch }) => api<Agent>(`/agents/${id}`, { method: 'PATCH', body: patch }), onSettled: (_d, _e, v) => done(v.id)() }),
    remove: useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/agents/${id}`, { method: 'DELETE' }), onSettled: done() }),
    setDocuments: useMutation({ mutationFn: ({ id, ids }: { id: string; ids: string[] }) => put<Agent>(`/agents/${id}/documents`, { document_ids: ids }), onSettled: (_d, _e, v) => done(v.id)() }),
    setChannels: useMutation({ mutationFn: ({ id, ids }: { id: string; ids: string[] }) => put<Agent>(`/agents/${id}/channels`, { channel_ids: ids }), onSettled: (_d, _e, v) => done(v.id)() }),
    removePhoto: useMutation({ mutationFn: (id: string) => api<Agent>(`/agents/${id}/photo`, { method: 'DELETE' }), onSettled: (_d, _e, id) => done(id)() }),
    test: useMutation({ mutationFn: ({ id, message, history, contactId }: { id: string; message: string; history: Array<{ role: 'user' | 'assistant'; text: string }>; contactId: string | null }) => api<TestTurn>(`/agents/${id}/test`, { method: 'POST', body: { message, history, contact_id: contactId } }) }),
    preview: useMutation({ mutationFn: (b: Record<string, unknown>) => api<AgentPreview>('/agents/preview', { method: 'POST', body: b }) }),
    uploadPhoto: useMutation({
      mutationFn: async ({ id, file }: { id: string; file: File }): Promise<Agent> => {
        const res = await fetch(`/v1/agents/${id}/photo`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'x-requested-by': 'sales-smart-web', ...(tokens.get() ? { authorization: `Bearer ${tokens.get()}` } : {}) },
          body: await file.arrayBuffer(),
          credentials: 'same-origin',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
          throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? `Error ${res.status}`, undefined, undefined, (body?.error?.details as ErrorDetail[]) ?? []);
        }
        return (await res.json()) as Agent;
      },
      onSettled: (_d, _e, v) => done(v.id)(),
    }),
  };
}
