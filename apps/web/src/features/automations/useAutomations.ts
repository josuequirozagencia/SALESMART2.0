import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export type TriggerType = 'contact_created' | 'message_received' | 'opportunity_created' | 'stage_changed' | 'field_changed' | 'sale_created';
export type ActionType = 'assign_user' | 'assign_queue' | 'move_stage' | 'set_field' | 'add_tag' | 'remove_tag' | 'create_task' | 'send_text' | 'send_template' | 'wait' | 'run_rule' | 'start_agent';
export type WaitUnit = 'minutes' | 'hours' | 'days';
export type AutomationStatus = 'draft' | 'active' | 'paused';

export interface Trigger {
  type: TriggerType;
  /** Según el disparador: `source`, `channel_id`, `pipeline_id`, `to_stage_id`, `to_status`, `field`, `value`. */
  filter: Record<string, string>;
}
/** `field`: `custom:<variable>`, `tag`, `source`, `owner` o `consent`. */
export interface Condition {
  field: string;
  op: string;
  value?: string;
}
/** Una acción: solo se usan los datos de su tipo (el servidor valida la forma estricta). */
export interface Action {
  type: ActionType;
  user_id?: string;
  queue_id?: string;
  stage_id?: string;
  field?: string;
  value?: string;
  tag_id?: string;
  title?: string;
  due_in_hours?: number;
  /** `owner` (el responsable del contacto) o el id de una persona. */
  assignee?: string;
  text?: string;
  channel_id?: string;
  template_id?: string;
  params?: Record<string, string>;
  /** Esperar: cuánto y en qué unidad (de 1 minuto a 30 días). */
  amount?: number;
  unit?: WaitUnit;
  /** Ejecutar otra automatización. */
  automation_id?: string;
}

export interface Automation {
  id: string;
  name: string;
  description: string | null;
  status: AutomationStatus;
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
  version: number;
  /** Ejecuciones de los últimos 7 días por resultado. */
  recent: { done: number; skipped: number; failed: number; queued: number; waiting: number };
  created_at: string;
  updated_at: string;
}
export interface AutomationList {
  items: Automation[];
  limits: { max_automations: number };
}
export interface AutomationInput {
  name: string;
  description: string | null;
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
}

export interface RunStep {
  position: number;
  action: string;
  label: string;
  outcome: 'done' | 'skipped' | 'failed';
  detail: string | null;
}
export interface Run {
  id: string;
  at: string;
  /** `waiting`: una acción «esperar» la dejó en pausa hasta `resume_at`. */
  status: 'queued' | 'waiting' | 'done' | 'skipped' | 'failed';
  resume_at: string | null;
  reason: string | null;
  event_type: string;
  depth: number;
  contact: { id: string; name: string };
  steps: RunStep[];
}
export interface DryRun {
  contact: { id: string; name: string };
  conditions: Array<{ index: number; met: boolean }>;
  meets: boolean;
  actions: Array<{ position: number; action: string; label: string; would: 'do' | 'skip' | 'fail'; detail: string; after_wait: boolean }>;
}

/** Solo conserva los datos que corresponden al tipo de la acción (lo demás el servidor lo rechazaría por forma estricta). */
export function cleanAction(a: Action): Action {
  switch (a.type) {
    case 'assign_user':
      return { type: a.type, user_id: a.user_id ?? '' };
    case 'assign_queue':
      return { type: a.type, queue_id: a.queue_id ?? '' };
    case 'move_stage':
      return { type: a.type, stage_id: a.stage_id ?? '' };
    case 'set_field':
      return { type: a.type, field: a.field ?? '', value: a.value ?? '' };
    case 'add_tag':
    case 'remove_tag':
      return { type: a.type, tag_id: a.tag_id ?? '' };
    case 'create_task':
      return { type: a.type, title: a.title ?? '', ...(a.due_in_hours !== undefined && Number.isFinite(a.due_in_hours) ? { due_in_hours: a.due_in_hours } : {}), assignee: a.assignee || 'owner' };
    case 'send_text':
      return { type: a.type, text: a.text ?? '' };
    case 'send_template':
      return { type: a.type, channel_id: a.channel_id ?? '', template_id: a.template_id ?? '', params: a.params ?? {} };
    case 'wait':
      return { type: a.type, amount: a.amount ?? 1, unit: a.unit ?? 'hours' };
    case 'run_rule':
      return { type: a.type, automation_id: a.automation_id ?? '' };
    case 'start_agent':
      return { type: a.type };
  }
}

/** Las automatizaciones de la empresa (solo el administrador; para el resto el servidor responde 403). */
export function useAutomations() {
  return useQuery({ queryKey: ['automations'], retry: false, queryFn: () => api<AutomationList>('/automations') });
}

export function useAutomationRuns(id: string, enabled: boolean) {
  return useQuery({ queryKey: ['automation-runs', id], enabled, retry: false, queryFn: () => api<{ items: Run[]; next_cursor: string | null }>(`/automations/${id}/runs?limit=50`) });
}

export function useAutomationMutations() {
  const qc = useQueryClient();
  const done = (id?: string) => async (): Promise<void> => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['automations'] }), id ? qc.invalidateQueries({ queryKey: ['automation-runs', id] }) : Promise.resolve()]);
  };
  return {
    create: useMutation({ mutationFn: (b: AutomationInput) => api<Automation>('/automations', { method: 'POST', body: { ...b, actions: b.actions.map(cleanAction) } }), onSettled: done() }),
    update: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<AutomationInput> }) => api<Automation>(`/automations/${id}`, { method: 'PATCH', body: { ...patch, ...(patch.actions ? { actions: patch.actions.map(cleanAction) } : {}) } }), onSettled: (_d, _e, v) => done(v.id)() }),
    activate: useMutation({ mutationFn: (id: string) => api<Automation>(`/automations/${id}/activate`, { method: 'POST' }), onSettled: (_d, _e, id) => done(id)() }),
    pause: useMutation({ mutationFn: (id: string) => api<Automation>(`/automations/${id}/pause`, { method: 'POST' }), onSettled: (_d, _e, id) => done(id)() }),
    remove: useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/automations/${id}`, { method: 'DELETE' }), onSettled: done() }),
    test: useMutation({ mutationFn: ({ id, contactId }: { id: string; contactId: string }) => api<DryRun>(`/automations/${id}/test`, { method: 'POST', body: { contact_id: contactId } }) }),
  };
}
