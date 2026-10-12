/** Contratos de la API que consume la web (ver apps/api: auth, trials). Snake_case tal como los envía el servidor. */
export type Role = 'super_admin' | 'agency' | 'client_admin' | 'advisor';

export interface Me {
  user: { id: string; email: string; full_name: string | null };
  organization: { id: string; name: string; kind: 'platform' | 'agency' | 'client' };
  role: Role;
}

export interface LoginResponse extends Me {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export type ExtensionStatus = 'none' | 'pending' | 'approved' | 'denied';

export interface Trial {
  status: 'active' | 'expired';
  started_at: string;
  ends_at: string;
  retention_days: number;
  extension_days: number;
  extension: { status: ExtensionStatus; can_request: boolean; requested_at: string | null; decided_at: string | null; days_granted: number | null };
}

/** Fila de la pestaña «Pruebas» de la consola de plataforma (solo la ve el Súper Admin). */
export interface PlatformTrialItem {
  id: string;
  organization_id: string;
  organization_name: string;
  owner_email: string;
  owner_name: string | null;
  owner_phone: string | null;
  status: 'active' | 'expired';
  started_at: string;
  ends_at: string;
  extension: { status: ExtensionStatus; can_request: boolean; requested_at: string | null; decided_at: string | null; days_granted: number | null; reason: string | null };
}

export interface PlatformTrialList {
  items: PlatformTrialItem[];
  next_cursor: string | null;
  pending_extensions: number;
  summary: { active: number; expiring_soon: number; pending: number; extension_days: number };
}
