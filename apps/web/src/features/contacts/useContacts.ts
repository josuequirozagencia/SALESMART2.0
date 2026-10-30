import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { Consent, Contact, ContactList, CustomValue, OwnerOption } from '../../lib/types';

export type SortKey = 'recent' | 'oldest' | 'az' | 'za';
export interface ContactFilters {
  q: string;
  /** '' = todos · 'me' = míos · 'none' = sin asignar · otro = id de la persona (solo quien ve todos los contactos). */
  owner: string;
  consent: '' | Consent;
  /** Id de la empresa por la que se filtra ('' = todas) y su nombre (solo para mostrar la etiqueta; no se envía). */
  company: string;
  companyName: string;
  /** Ids de etiquetas: el contacto debe tener TODAS. */
  tags: string[];
  /** Filtros de campos personalizados, `variable:operador[:valor]`. */
  cf: string[];
  sort: SortKey;
}
export const NO_CONTACT_FILTERS: ContactFilters = { q: '', owner: '', consent: '', company: '', companyName: '', tags: [], cf: [], sort: 'recent' };
export const SORT_LABEL: Record<SortKey, string> = { recent: 'Más recientes', oldest: 'Más antiguos', az: 'Nombre (A–Z)', za: 'Nombre (Z–A)' };
export const SORT_PARAMS: Record<SortKey, { sort: 'created_at' | 'updated_at' | 'name'; order: 'asc' | 'desc' }> = {
  recent: { sort: 'created_at', order: 'desc' },
  oldest: { sort: 'created_at', order: 'asc' },
  az: { sort: 'name', order: 'asc' },
  za: { sort: 'name', order: 'desc' },
};
const PAGE = 25;

/** ¿Hay algún filtro puesto? (el orden no cuenta). */
export const hasFilters = (f: ContactFilters): boolean => f.q.trim() !== '' || f.owner !== '' || f.consent !== '' || f.company !== '' || f.tags.length > 0 || f.cf.length > 0;

export function contactsQuery(f: ContactFilters, cursor?: string, list?: string): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.owner) p.set('owner', f.owner);
  if (f.consent) p.set('consent', f.consent);
  if (f.company) p.set('company', f.company);
  for (const t of f.tags) p.append('tag', t);
  for (const c of f.cf) p.append('cf', c);
  if (list) p.set('list', list);
  const s = SORT_PARAMS[f.sort];
  p.set('sort', s.sort);
  p.set('order', s.order);
  p.set('limit', String(PAGE));
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

/** Contactos de la organización activa. El servidor decide cuáles ve la persona (los suyos, o todos con `contacts.view_all`). */
export function useContacts(f: ContactFilters, list?: string) {
  return useInfiniteQuery({
    queryKey: ['contacts', 'list', f, list ?? null],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<ContactList>(`/contacts?${contactsQuery(f, pageParam, list)}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** Personas a las que se puede asignar un contacto. Sin permiso el servidor responde 403: la lista queda vacía. */
export function useOwners(enabled: boolean) {
  return useQuery({
    queryKey: ['contacts', 'owners'],
    enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<OwnerOption[]> => {
      try {
        return (await api<{ items: OwnerOption[] }>('/contacts/owners')).items;
      } catch {
        return [];
      }
    },
  });
}

export interface ContactInput {
  name: string;
  email: string | null;
  phones: string[];
  consent: Consent;
  /** Solo se envía si la persona puede asignar (si no, el servidor lo asigna a quien lo crea). */
  owner_id?: string | null;
  /** Campos personalizados (ADR-44): solo las variables que cambian; `null` vacía el valor. */
  custom_fields?: Record<string, CustomValue | null>;
  /** Etiquetas PERSONALIZADAS (ADR-46): reemplaza el conjunto; las del sistema no se tocan. */
  tag_ids?: string[];
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ContactInput) => api<Contact>('/contacts', { method: 'POST', body: input }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<ContactInput> }) => api<Contact>(`/contacts/${id}`, { method: 'PATCH', body: input }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/contacts/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  });
}
