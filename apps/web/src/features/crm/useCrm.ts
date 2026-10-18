import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { CrmCompany, CrmCompanyContact, CrmCompanyList, Note, Task, TaskList } from '../../lib/types';

// ── Empresas ────────────────────────────────────────────────────────────────

export function useCompanies(q: string) {
  return useInfiniteQuery({
    queryKey: ['companies', 'list', q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<CrmCompanyList>(`/companies?${new URLSearchParams({ ...(q ? { q } : {}), limit: '25', ...(pageParam ? { cursor: pageParam } : {}) }).toString()}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useCompanyContacts(id: string) {
  return useInfiniteQuery({
    queryKey: ['companies', id, 'contacts'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<{ items: CrmCompanyContact[]; next_cursor: string | null }>(`/companies/${id}/contacts?${new URLSearchParams({ limit: '50', ...(pageParam ? { cursor: pageParam } : {}) }).toString()}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export interface CompanyInput {
  name: string;
  website: string | null;
  phone: string | null;
  email: string | null;
}

/** Cambiar una empresa o sus vínculos afecta a la lista de empresas, a sus contactos y a las fichas de contacto (que muestran sus empresas). */
function useRefreshCompanies() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: ['companies'] }), qc.invalidateQueries({ queryKey: ['contacts'] }), qc.invalidateQueries({ queryKey: ['tasks'] })]);
}

export function useCreateCompany() {
  const done = useRefreshCompanies();
  return useMutation({ mutationFn: (input: CompanyInput) => api<CrmCompany>('/companies', { method: 'POST', body: input }), onSettled: done });
}
export function useUpdateCompany() {
  const done = useRefreshCompanies();
  return useMutation({ mutationFn: ({ id, input }: { id: string; input: Partial<CompanyInput> }) => api<CrmCompany>(`/companies/${id}`, { method: 'PATCH', body: input }), onSettled: done });
}
export function useDeleteCompany() {
  const done = useRefreshCompanies();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/companies/${id}`, { method: 'DELETE' }), onSettled: done });
}
export function useLinkContacts() {
  const done = useRefreshCompanies();
  return useMutation({ mutationFn: ({ companyId, ids }: { companyId: string; ids: string[] }) => api<{ added: number; skipped: number }>(`/companies/${companyId}/contacts`, { method: 'POST', body: { contact_ids: ids } }), onSettled: done });
}
export function useUnlinkContacts() {
  const done = useRefreshCompanies();
  return useMutation({ mutationFn: ({ companyId, ids }: { companyId: string; ids: string[] }) => api<{ removed: number }>(`/companies/${companyId}/contacts/remove`, { method: 'POST', body: { contact_ids: ids } }), onSettled: done });
}
/** Desde la ficha de un contacto. */
export function useLinkCompany() {
  const done = useRefreshCompanies();
  return useMutation({ mutationFn: ({ contactId, companyId }: { contactId: string; companyId: string }) => api<{ linked: true }>(`/contacts/${contactId}/companies/${companyId}`, { method: 'POST' }), onSettled: done });
}
export function useUnlinkCompany() {
  const done = useRefreshCompanies();
  return useMutation({ mutationFn: ({ contactId, companyId }: { contactId: string; companyId: string }) => api<{ unlinked: true }>(`/contacts/${contactId}/companies/${companyId}`, { method: 'DELETE' }), onSettled: done });
}

// ── Notas ───────────────────────────────────────────────────────────────────

export type NoteTarget = { kind: 'contact' | 'company'; id: string };
const notesPath = (t: NoteTarget): string => `/${t.kind === 'contact' ? 'contacts' : 'companies'}/${t.id}/notes`;

export function useNotes(t: NoteTarget) {
  return useInfiniteQuery({
    queryKey: ['notes', t.kind, t.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<{ items: Note[]; next_cursor: string | null }>(`${notesPath(t)}?${new URLSearchParams({ limit: '30', ...(pageParam ? { cursor: pageParam } : {}) }).toString()}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}
export function useAddNote(t: NoteTarget) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: string) => api<Note>(notesPath(t), { method: 'POST', body: { body } }), onSettled: () => qc.invalidateQueries({ queryKey: ['notes', t.kind, t.id] }) });
}
export function useEditNote(t: NoteTarget) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: string }) => api<Note>(`/notes/${id}`, { method: 'PATCH', body: { body } }), onSettled: () => qc.invalidateQueries({ queryKey: ['notes', t.kind, t.id] }) });
}
export function useDeleteNote(t: NoteTarget) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/notes/${id}`, { method: 'DELETE' }), onSettled: () => qc.invalidateQueries({ queryKey: ['notes', t.kind, t.id] }) });
}

// ── Tareas ──────────────────────────────────────────────────────────────────

export type TaskStatusFilter = 'open' | 'done' | 'all';
export interface TaskFilters {
  status: TaskStatusFilter;
  /** `me`, `all` o el id de una persona (los dos últimos, solo quien ve todo). */
  assignee: string;
  overdue: boolean;
  contact?: string | undefined;
  company?: string | undefined;
}
export const DEFAULT_TASK_FILTERS: TaskFilters = { status: 'open', assignee: 'me', overdue: false };

export function tasksQuery(f: TaskFilters, cursor?: string): string {
  const p = new URLSearchParams({ status: f.status, assignee: f.assignee, sort: 'due', limit: '25' });
  if (f.overdue) p.set('overdue', 'true');
  if (f.contact) p.set('contact', f.contact);
  if (f.company) p.set('company', f.company);
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

export function useTasks(f: TaskFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['tasks', 'list', f],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<TaskList>(`/tasks?${tasksQuery(f, pageParam)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export interface TaskInput {
  title: string;
  description: string | null;
  due_at: string | null;
  assignee_id?: string;
  contact_id?: string | null;
  company_id?: string | null;
}

function useRefreshTasks() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['tasks'] });
}
export function useCreateTask() {
  const done = useRefreshTasks();
  return useMutation({ mutationFn: (input: TaskInput) => api<Task>('/tasks', { method: 'POST', body: input }), onSettled: done });
}
export function useUpdateTask() {
  const done = useRefreshTasks();
  return useMutation({ mutationFn: ({ id, input }: { id: string; input: Partial<TaskInput> }) => api<Task>(`/tasks/${id}`, { method: 'PATCH', body: input }), onSettled: done });
}
export function useSetTaskDone() {
  const done = useRefreshTasks();
  return useMutation({ mutationFn: ({ id, done: d }: { id: string; done: boolean }) => api<Task>(`/tasks/${id}/${d ? 'complete' : 'reopen'}`, { method: 'POST' }), onSettled: done });
}
export function useDeleteTask() {
  const done = useRefreshTasks();
  return useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/tasks/${id}`, { method: 'DELETE' }), onSettled: done });
}
