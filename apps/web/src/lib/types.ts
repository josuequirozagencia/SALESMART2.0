/** Contratos de la API que consume la web (ver apps/api: auth, trials). Snake_case tal como los envía el servidor. */
export type Role = 'super_admin' | 'agency' | 'client_admin' | 'advisor';

/** Nivel con el que una agencia entra a un cliente (ADR-11/41). «Sin acceso» = no está en su cartera. */
export type AccessLevel = 'read' | 'advisor' | 'admin';
/** Quién actúa dentro de una organización que no es la suya: el Súper Admin (soporte) o una agencia en un cliente. */
export type ActingAs = 'super_admin' | 'agency';
export type OrgKind = 'platform' | 'agency' | 'client';

/**
 * Quién soy y en qué contexto estoy. La web solo lo PINTA (banner, solo lectura): el servidor vuelve a verificar todo en cada petición.
 * `home` es la organización con la que empezó la sesión («Volver a mi agencia»).
 */
export interface Me {
  user: { id: string; email: string; full_name: string | null };
  organization: { id: string; name: string; kind: OrgKind };
  role: Role;
  home: { id: string; name: string; kind: OrgKind };
  acting_as: ActingAs | null;
  read_only: boolean;
  access_level: AccessLevel | null;
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

export type CompanyState = 'trial' | 'trial_expired' | 'active' | 'suspended' | 'invited';

export interface Company {
  id: string;
  name: string;
  kind: 'client' | 'agency';
  state: CompanyState;
  plan: { id: string; name: string } | null;
  /** Agencia que administra al cliente (`null` = administración directa). */
  agency: { id: string; name: string } | null;
  /** Nivel con el que esa agencia entra al cliente (`null` si no tiene agencia). */
  agency_access_level: AccessLevel | null;
  users: number;
  owner_email: string | null;
  timezone: string;
  country: string | null;
  created_at: string;
  trial_ends_at: string | null;
  /** Invitación pendiente del dueño (solo en estado `invited`). */
  invitation: { email: string; expires_at: string; expired: boolean } | null;
}

/** `sent` = el correo salió (el enlace NO viaja); si no, `invite_url` va solo al Súper Admin para entregarlo por otro medio (ADR-39). */
export interface InvitationIssued {
  email: string;
  expires_at: string;
  delivery: 'sent' | 'failed' | 'unavailable';
  invite_url?: string;
}

export interface CompanyCreated {
  company: { id: string; name: string; kind: 'client' | 'agency'; state: 'invited'; plan: { id: string; name: string } | null; timezone: string; country: string };
  invitation: InvitationIssued;
}

export interface InvitationPreview {
  organization_name: string;
  email: string;
  role: string;
  expires_at: string;
  account_exists: boolean;
}

export interface CompanyList {
  items: Company[];
  next_cursor: string | null;
}

export type AgencyState = 'active' | 'suspended' | 'invited';

export interface Agency {
  id: string;
  name: string;
  state: AgencyState;
  /** Dueño de la agencia o, mientras no acepte, el correo invitado. */
  owner_email: string | null;
  clients: number;
  timezone: string;
  country: string | null;
  created_at: string;
  invitation: { email: string; expires_at: string; expired: boolean } | null;
}

export interface AgencyList {
  items: Agency[];
  next_cursor: string | null;
}

export interface OwnershipHistoryItem {
  id: string;
  organization: { id: string; name: string };
  from: { id: string; name: string } | null;
  to: { id: string; name: string } | null;
  reason: string | null;
  notify_client: boolean;
  changed_by: string | null;
  changed_at: string;
}

export interface AssignAgencyResult {
  id: string;
  agency: { id: string; name: string } | null;
  changed: boolean;
  /** Avisos enviados al administrador del cliente. */
  notified: number;
}

/** Cliente al que la persona puede entrar con una membresía vigente (el selector «Cambiar de cliente»). */
export interface ContextOption {
  id: string;
  name: string;
  role: Role;
  access_level: AccessLevel | null;
}

export type AccessEndReason = 'switch' | 'return' | 'access_removed' | 'session_ended';

/** Una entrada de un Súper Admin o una agencia a otra organización (solo la ve el Súper Admin). */
export interface AccessSession {
  id: string;
  actor: { email: string; name: string | null };
  actor_role: 'super_admin' | 'agency';
  organization: { id: string; name: string; kind: OrgKind };
  started_at: string;
  ended_at: string | null;
  end_reason: AccessEndReason | null;
  open: boolean;
  duration_seconds: number;
}

export interface AccessSessionList {
  items: AccessSession[];
  next_cursor: string | null;
}

// ── Proveedores de la plataforma (M2.6, ADR-42; solo Súper Admin) ──
export type ProviderManaged = 'platform' | 'env' | 'client' | 'fixed';
export type ProviderMaturity = 'planned' | 'reserved' | 'candidate';

/** Un dato de un proveedor. NINGÚN valor llega jamás (ni claves ni URL): solo si existe y su final (últimos 4). `masked` = se teclea oculto. */
export interface ProviderField {
  key: string;
  label: string;
  masked: boolean;
  required: boolean;
  hint: string | null;
  set: boolean;
  last4: string | null;
}
export interface ProviderItem {
  key: string;
  label: string;
  maturity: ProviderMaturity;
  note: string | null;
  configured: boolean;
  fields: ProviderField[];
  updated_at: string | null;
}
export interface ProviderService {
  key: string;
  label: string;
  adapter: string;
  managed: ProviderManaged;
  note: string;
  active: string | null;
  /** Solo los servicios gestionados por variables de entorno (correo, anti-bots): su modo actual. */
  mode: string | null;
  providers: ProviderItem[];
}
export interface ProvidersList {
  vault: { available: boolean };
  services: ProviderService[];
}

// ── Contactos (M3.1, ADR-43) ──
export type Consent = 'unknown' | 'granted' | 'revoked';

export interface Contact {
  id: string;
  name: string;
  email: string | null;
  /** El primero es el principal. Números en E.164. */
  phones: Array<{ e164: string; primary: boolean }>;
  owner: { id: string; name: string } | null;
  source: string;
  consent: Consent;
  consent_updated_at: string | null;
  /** Campos personalizados (M3.2): `{ variable: valor }`, solo los no vacíos de campos no archivados. */
  custom_fields: Record<string, CustomValue>;
  /** Etiquetas del contacto (M3.3): las del sistema las pone el sistema. */
  tags: ContactTag[];
  /** Origen del lead por Click-to-WhatsApp (M3.3); null si no llegó por un anuncio. */
  attribution: ContactAttribution | null;
  created_at: string;
  updated_at: string;
}

export interface ContactList {
  items: Contact[];
  next_cursor: string | null;
  /** Solo en la primera página. */
  total: number | null;
  /** Qué puede hacer quien consulta: la UI muestra u oculta acciones con esto (el servidor vuelve a verificar cada una). */
  access: ContactAccess;
}

export interface ContactAccess {
  view_all: boolean;
  write: boolean;
  delete: boolean;
}

/** Persona a la que se puede asignar un contacto (solo lo ve quien puede ver todos los contactos). */
export interface OwnerOption {
  id: string;
  name: string;
  email: string;
  role: Role;
}

// ── Campos personalizados (M3.2, ADR-44) ──
export type CustomFieldType = 'text' | 'long_text' | 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'boolean' | 'email' | 'phone' | 'url' | 'select' | 'multiselect';
/** Valor tal como lo manda y lo devuelve la API: texto, número, Sí/No o lista (selección múltiple). */
export type CustomValue = string | number | boolean | string[];

export interface CustomField {
  id: string;
  entity: 'contact';
  name: string;
  /** Variable de plantillas y automatizaciones: `{{contact.<key>}}`. No cambia nunca. */
  key: string;
  type: CustomFieldType;
  options: string[] | null;
  required: boolean;
  show_in_form: boolean;
  position: number;
  archived_at: string | null;
  created_at: string;
}

export interface CustomFieldList {
  items: CustomField[];
  /** `manage`: puede crear, cambiar, archivar y ordenar campos (el servidor vuelve a verificar cada acción). */
  access: { manage: boolean };
}

// ── Etiquetas del sistema y atribución de Meta (M3.3, ADR-45) ──
export interface ContactTag {
  id: string;
  name: string;
  color: string;
  system_key: 'lead' | 'appointment' | 'sale' | null;
  is_system: boolean;
}
export interface ContactTouch {
  at: string;
  source: string | null;
  campaign: string | null;
  adset: string | null;
  ad: string | null;
}
export interface ContactAttribution {
  ctwa_cl_id: string | null;
  first_touch: ContactTouch | null;
  last_touch: ContactTouch | null;
  /** Último evento Purchase hacia Meta (null si nunca hubo uno). */
  capi: { status: string; sent_at: string | null } | null;
}
export interface AttributionEndpoint {
  configured: boolean;
  id: string | null;
  path: string | null;
  created_at: string | null;
  rotated_at: string | null;
  last_used_at: string | null;
}
/** Respuesta de generar o regenerar: el secreto viene SOLO aquí. */
export interface AttributionEndpointIssued {
  id: string;
  secret: string;
  rotated: boolean;
  path: string;
}
