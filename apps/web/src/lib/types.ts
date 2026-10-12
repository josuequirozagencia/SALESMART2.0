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
  /** Si la empresa ya tiene plan dejó de estar en prueba (ADR-38). */
  plan_name: string | null;
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

/** Plan de la plataforma (módulos que enciende y límites; null = ilimitado). Sin precios todavía. */
export interface Plan {
  id: string;
  name: string;
  description: string | null;
  max_users: number | null;
  max_connections: number | null;
  max_queues: number | null;
  features: Record<string, boolean>;
  archived: boolean;
  created_at: string;
  updated_at: string;
  /** Empresas que lo usan hoy. */
  companies: number;
}

export interface PlanList {
  items: Plan[];
  /** Módulos que un plan puede encender (los define el servidor). */
  feature_catalog: Array<{ key: string; label: string }>;
}

export type CompanyState = 'trial' | 'trial_expired' | 'active' | 'suspended';

export interface Company {
  id: string;
  name: string;
  kind: 'client' | 'agency';
  state: CompanyState;
  plan: { id: string; name: string } | null;
  users: number;
  owner_email: string | null;
  timezone: string;
  created_at: string;
  trial_ends_at: string | null;
}

export interface CompanyList {
  items: Company[];
  next_cursor: string | null;
}
