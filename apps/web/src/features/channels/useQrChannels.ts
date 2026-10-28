import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

/** `created` sin vincular · `connecting` esperando el QR o reconectando (NO es una caída) · `open` activa · `logged_out` el teléfono cerró la sesión · `closed` caída. */
export type QrState = 'created' | 'connecting' | 'open' | 'logged_out' | 'closed';

export interface QrChannel {
  id: string;
  provider: 'evolution';
  is_official: false;
  name: string;
  state: QrState;
  phone: string | null;
  profile_name: string | null;
  queue_id: string | null;
  connected_at: string | null;
  last_event_at: string | null;
  /** Desde cuándo está caída la sesión (null si está bien). */
  down_since: string | null;
  last_error: string | null;
  /** Calentamiento del número: día en que va y cuántos mensajes puede enviar hoy. */
  warmup: { day: number; daily_limit: number };
  created_at: string;
}
export interface QrList {
  items: QrChannel[];
  /** `false`: la plataforma no tiene WhatsApp por QR configurado o está apagado. */
  available: boolean;
  limits: { max_channels: number };
}
export interface QrCode {
  /** La imagen del QR (PNG como `data:`), o null si la sesión ya está abierta. */
  qr: string | null;
  state: QrState;
  /** Segundos que dura el QR. */
  expires_in: number;
}

/** Las conexiones de WhatsApp por QR de la empresa (solo quien administra conexiones; para el resto el servidor responde 403). */
export function useQrChannels() {
  return useQuery({ queryKey: ['qr-channels'], retry: false, queryFn: () => api<QrList>('/qr-channels') });
}

/** El estado de UNA conexión, consultado a Evolution cada pocos segundos mientras se escanea el QR. */
export function useQrStatus(id: string | null, intervalMs: number | false) {
  return useQuery({ queryKey: ['qr-channel', id], enabled: id !== null, retry: false, refetchInterval: intervalMs, queryFn: () => api<QrChannel>(`/qr-channels/${id}`) });
}

export function useQrMutations() {
  const qc = useQueryClient();
  const done = (): Promise<unknown> => Promise.all([qc.invalidateQueries({ queryKey: ['qr-channels'] }), qc.invalidateQueries({ queryKey: ['queues'] })]);
  return {
    create: useMutation({ mutationFn: (b: { name: string; queue_id?: string | null }) => api<QrChannel>('/qr-channels', { method: 'POST', body: b }), onSettled: done }),
    code: useMutation({ mutationFn: (id: string) => api<QrCode>(`/qr-channels/${id}/qr`, { method: 'POST' }), onSettled: done }),
    disconnect: useMutation({ mutationFn: (id: string) => api<QrChannel>(`/qr-channels/${id}/disconnect`, { method: 'POST' }), onSettled: done }),
    update: useMutation({ mutationFn: ({ id, patch }: { id: string; patch: { name?: string; queue_id?: string | null } }) => api<QrChannel>(`/qr-channels/${id}`, { method: 'PATCH', body: patch }), onSettled: done }),
    remove: useMutation({ mutationFn: (id: string) => api<{ id: string; deleted: true }>(`/qr-channels/${id}`, { method: 'DELETE' }), onSettled: done }),
  };
}
