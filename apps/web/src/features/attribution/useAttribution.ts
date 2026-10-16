import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { AttributionEndpoint, AttributionEndpointIssued } from '../../lib/types';

/** Estado del punto de entrada de atribución de la empresa (solo quien administra integraciones; para el resto el servidor responde 403). */
export function useAttributionEndpoint() {
  return useQuery({ queryKey: ['attribution', 'endpoint'], retry: false, queryFn: () => api<AttributionEndpoint>('/attribution/endpoint') });
}

/** Crea el punto de entrada o regenera su secreto. El secreto viene SOLO en esta respuesta. */
export function useIssueEndpoint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<AttributionEndpointIssued>('/attribution/endpoint', { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['attribution'] }),
  });
}
