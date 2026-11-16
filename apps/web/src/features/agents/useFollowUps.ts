import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, tokens, type ErrorDetail } from '../../lib/api';

export type FollowUpMode = 'ai' | 'fixed_text' | 'none';

/** Un archivo de un paso (v15): nunca la clave del almacenamiento. */
export interface FollowUpFile {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'document';
  mime_type: string;
  filename: string;
  size_bytes: number;
  /** `clean`: el antivirus lo revisó · `skipped`: este servidor no tiene antivirus y el archivo NO se revisó. */
  scan_status: 'clean' | 'skipped';
  step_position: number | null;
  sort_order: number;
}

export interface FollowUpStep {
  position: number;
  delay_minutes: number;
  mode: FollowUpMode;
  fixed_text: string | null;
  start_automation_id: string | null;
  files: FollowUpFile[];
}

export interface FollowUps {
  scenario: 'stopped_replying';
  enabled: boolean;
  steps: FollowUpStep[];
  /** Archivos subidos que aún no están en ningún paso. */
  loose_files: FollowUpFile[];
  /** Lo que ocupan los archivos de los seguimientos de este agente y lo que admite cada tipo; `available`: hay dónde guardar archivos. */
  files_storage: { files: number; bytes: number; available: boolean; limits: { max_per_step: number; max_mb: Record<FollowUpFile['kind'], number> } };
  /** Qué tipos de conexión atiende el agente: oficial (ventana de 24 h), QR (sin ventana) y GoHighLevel (solo texto). */
  channels: { official: boolean; qr: boolean; ghl: boolean };
  /** Variables que puede llevar un texto fijo. */
  variables: string[];
  /** Automatizaciones activas que un paso puede iniciar. */
  automations: Array<{ id: string; name: string }>;
  /** Lo que pasó en los últimos 7 días. */
  summary: { sent: number; skipped: number; cancelled: number; pending: number; reasons: Record<string, number> };
  updated_at: string | null;
}

export interface FollowUpsInput {
  enabled: boolean;
  steps: Array<{ delay_minutes: number; mode: FollowUpMode; fixed_text?: string | null; start_automation_id?: string | null; file_ids?: string[] }>;
}

/** Sube un archivo para un paso (cuerpo crudo con su tipo y nombre). El servidor lo revisa por su contenido real, tamaño y antivirus; los errores llegan en español. */
export function useUploadFollowUpFile(agentId: string) {
  return useMutation({
    mutationFn: async (file: File): Promise<FollowUpFile> => {
      const res = await fetch(`/v1/agents/${agentId}/follow-ups/files`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-requested-by': 'sales-smart-web', ...(tokens.get() ? { authorization: `Bearer ${tokens.get()}` } : {}) },
        body: await file.arrayBuffer(),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
        throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? `Error ${res.status}`, undefined, undefined, (body?.error?.details as ErrorDetail[]) ?? []);
      }
      return (await res.json()) as FollowUpFile;
    },
  });
}

/** Quita un archivo (vence y se borra del almacenamiento). */
export function useRemoveFollowUpFile(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api<FollowUps>(`/agents/${agentId}/follow-ups/files/${fileId}`, { method: 'DELETE' }),
    onSuccess: (data) => qc.setQueryData(['agent-follow-ups', agentId], data),
  });
}

/** Una URL firmada de pocos minutos para la miniatura del archivo (solo imágenes). */
export function useFollowUpFilePreview(agentId: string, file: FollowUpFile) {
  return useQuery({
    queryKey: ['agent-follow-up-file-url', agentId, file.id],
    enabled: file.kind === 'image',
    retry: false,
    staleTime: 4 * 60_000,
    queryFn: () => api<{ url: string }>(`/agents/${agentId}/follow-ups/files/${file.id}/url`),
  });
}

/** Los seguimientos automáticos de un agente (v11 S5, ADR-68). Solo el administrador (`agents.manage`). */
export function useFollowUps(agentId: string) {
  return useQuery({ queryKey: ['agent-follow-ups', agentId], retry: false, queryFn: () => api<FollowUps>(`/agents/${agentId}/follow-ups`) });
}

export function useSaveFollowUps(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FollowUpsInput) => api<FollowUps>(`/agents/${agentId}/follow-ups`, { method: 'PUT', body }),
    onSuccess: (data) => qc.setQueryData(['agent-follow-ups', agentId], data),
  });
}

/** Cómo se cuenta cada motivo en el resumen de los últimos 7 días. */
export const REASON_LABEL: Record<string, string> = {
  client_replied: 'el cliente respondió',
  human_intervened: 'una persona intervino',
  agent_stopped: 'el agente estaba detenido',
  conversation_closed: 'la conversación terminó',
  owner_changed: 'cambió quien atiende',
  consent_revoked: 'el contacto retiró su consentimiento',
  agent_unavailable: 'el agente ya no atendía esa conexión',
  disabled: 'se apagaron los seguimientos',
  step_removed: 'se quitó el paso',
  superseded: 'el cliente volvió a escribir',
  window_closed: 'pasaron las 24 horas de WhatsApp',
  no_credits: 'no había créditos de IA',
  missing_variable: 'faltaba un dato del contacto',
  automation_unavailable: 'la automatización no estaba activa',
  daily_limit: 'se llegó al tope diario',
  channel_unavailable: 'la conexión no estaba disponible',
  ai_unavailable: 'la IA no respondió',
  empty_reply: 'la IA devolvió un mensaje vacío',
  attachment_unavailable: 'faltaba un archivo del paso',
  attachment_infected: 'el antivirus bloqueó un archivo del paso',
};
