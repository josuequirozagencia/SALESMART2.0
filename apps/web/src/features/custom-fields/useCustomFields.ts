import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { CustomField, CustomFieldList, CustomFieldType } from '../../lib/types';

export const FIELD_TYPE_LABEL: Record<CustomFieldType, string> = {
  text: 'Texto',
  long_text: 'Texto largo',
  number: 'Número',
  currency: 'Moneda',
  percent: 'Porcentaje',
  date: 'Fecha',
  datetime: 'Fecha y hora',
  boolean: 'Sí/No',
  email: 'Correo',
  phone: 'Teléfono',
  url: 'Enlace (URL)',
  select: 'Selección única',
  multiselect: 'Selección múltiple',
};
export const FIELD_TYPES = Object.keys(FIELD_TYPE_LABEL) as CustomFieldType[];
export const isOptionType = (t: CustomFieldType): boolean => t === 'select' || t === 'multiselect';

/** Campos personalizados del contacto. Por defecto solo los activos; `archived` incluye también los archivados (pantalla de Configuración). */
export function useCustomFields(opts: { archived?: boolean } = {}) {
  const archived = opts.archived === true;
  return useQuery({
    queryKey: ['custom-fields', archived ? 'all' : 'active'],
    staleTime: 30_000,
    queryFn: () => api<CustomFieldList>(`/custom-fields${archived ? '?archived=include' : ''}`),
  });
}

export interface FieldInput {
  name: string;
  type: CustomFieldType;
  options?: string[];
  required: boolean;
  show_in_form: boolean;
}

function useInvalidate() {
  const qc = useQueryClient();
  // Archivar o restaurar cambia qué valores muestran los contactos
  return (contacts: boolean) => Promise.all([qc.invalidateQueries({ queryKey: ['custom-fields'] }), contacts ? qc.invalidateQueries({ queryKey: ['contacts'] }) : Promise.resolve()]);
}

export function useCreateField() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (input: FieldInput) => api<CustomField>('/custom-fields', { method: 'POST', body: input }),
    onSettled: () => done(false),
  });
}

export function useUpdateField() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<Pick<FieldInput, 'name' | 'options' | 'required' | 'show_in_form'>> }) => api<CustomField>(`/custom-fields/${id}`, { method: 'PATCH', body: input }),
    onSettled: () => done(false),
  });
}

export function useArchiveField() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, archive }: { id: string; archive: boolean }) => api<CustomField>(`/custom-fields/${id}/${archive ? 'archive' : 'restore'}`, { method: 'POST' }),
    onSettled: () => done(true),
  });
}

export function useReorderFields() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (ids: string[]) => api<{ items: CustomField[] }>('/custom-fields/order', { method: 'PUT', body: { ids } }),
    onSettled: () => done(false),
  });
}
