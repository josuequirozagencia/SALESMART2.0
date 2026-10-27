import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { TemplateList } from '../../lib/types';

export type FieldKind = 'text' | 'long_text' | 'email' | 'phone' | 'number' | 'select';
export type FormStatus = 'draft' | 'published' | 'paused';

export interface FormCard {
  id: string;
  name: string;
  description: string | null;
  status: FormStatus;
  field_count: number;
  submissions: number;
  last_submission_at: string | null;
  /** El identificador público (solo permite enviar). */
  public_token: string;
  created_at: string;
}

/** Un campo del formulario; `maps_to`: `name`, `phone`, `email`, `note` o `custom:<variable>`. */
export interface FormField {
  id?: string;
  key?: string;
  kind: FieldKind;
  label: string;
  maps_to: string;
  required: boolean;
  options: string[] | null;
  placeholder?: string | null;
}

export interface FormDetail extends FormCard {
  queue_id: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  extra_tag_id: string | null;
  consent_text: string;
  thanks_message: string;
  redirect_url: string | null;
  allowed_domains: string[];
  phone_prefix: string;
  /** Seguimiento de cada envío: tarea para el responsable y, opcionalmente, una plantilla de WhatsApp. `params`: valor de cada variable de la plantilla por su clave (`body:1`). */
  follow_up: { task: boolean; channel_id: string | null; template_id: string | null; params: Record<string, string> };
  fields: FormField[];
  /** Qué le falta para poder publicarse. */
  missing: string[];
}

export type FormPatch = Partial<{
  name: string;
  description: string | null;
  queue_id: string | null;
  pipeline_id: string | null;
  stage_id: string | null;
  extra_tag_id: string | null;
  consent_text: string;
  thanks_message: string;
  redirect_url: string | null;
  allowed_domains: string[];
  phone_prefix: string;
  follow_up_task: boolean;
  follow_up_channel_id: string | null;
  follow_up_template_id: string | null;
  follow_up_params: Record<string, string>;
}>;

export interface FormSubmission {
  id: string;
  at: string;
  contact: { id: string; name: string };
  contact_created: boolean;
  source_url: string | null;
  utm: Record<string, string>;
  values: Record<string, unknown>;
}

export function useForms() {
  return useQuery({ queryKey: ['forms'], retry: false, queryFn: () => api<{ items: FormCard[]; limits: { max_forms: number } }>('/forms') });
}

export function useForm(id: string) {
  return useQuery({ queryKey: ['form', id], retry: false, queryFn: () => api<FormDetail>(`/forms/${id}`) });
}

/** Las plantillas de una conexión (para elegir la del seguimiento). Sin conexión elegida no consulta. */
export function useFollowUpTemplates(channelId: string) {
  return useQuery({ queryKey: ['channel-templates', channelId], enabled: channelId !== '', retry: false, queryFn: () => api<TemplateList>(`/channels/${channelId}/templates`) });
}

export function useFormSubmissions(id: string, enabled: boolean) {
  return useQuery({ queryKey: ['form-submissions', id], enabled, retry: false, queryFn: () => api<{ items: FormSubmission[]; next_cursor: string | null }>(`/forms/${id}/submissions?limit=50`) });
}

export function useFormMutations() {
  const qc = useQueryClient();
  const done = (id?: string) => async (): Promise<void> => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['forms'] }), id ? qc.invalidateQueries({ queryKey: ['form', id] }) : Promise.resolve()]);
  };
  return {
    create: useMutation({ mutationFn: (b: { name: string; description?: string | null }) => api<FormDetail>('/forms', { method: 'POST', body: b }), onSettled: done() }),
    update: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: FormPatch }) => api<FormDetail>(`/forms/${id}`, { method: 'PATCH', body: patch }), onSettled: (_d, _e, v) => done(v.id)() }),
    setFields: useMutation({ mutationFn: ({ id, fields }: { id: string; fields: FormField[] }) => api<FormDetail>(`/forms/${id}/fields`, { method: 'PUT', body: { fields: fields.map((f) => ({ ...(f.key ? { key: f.key } : {}), kind: f.kind, label: f.label, maps_to: f.maps_to, required: f.required, options: f.options, placeholder: f.placeholder?.trim() ? f.placeholder.trim() : null })) } }), onSettled: (_d, _e, v) => done(v.id)() }),
    publish: useMutation({ mutationFn: (id: string) => api<FormDetail>(`/forms/${id}/publish`, { method: 'POST' }), onSettled: (_d, _e, id) => done(id)() }),
    pause: useMutation({ mutationFn: (id: string) => api<FormDetail>(`/forms/${id}/pause`, { method: 'POST' }), onSettled: (_d, _e, id) => done(id)() }),
    remove: useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/forms/${id}`, { method: 'DELETE' }), onSettled: done() }),
  };
}
