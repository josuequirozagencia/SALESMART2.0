import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export type FollowUpMode = 'ai' | 'fixed_text' | 'none';

export interface FollowUpStep {
  position: number;
  delay_minutes: number;
  mode: FollowUpMode;
  fixed_text: string | null;
  start_automation_id: string | null;
}

export interface FollowUps {
  scenario: 'stopped_replying';
  enabled: boolean;
  steps: FollowUpStep[];
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
  steps: Array<{ delay_minutes: number; mode: FollowUpMode; fixed_text?: string | null; start_automation_id?: string | null }>;
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
};
