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
  /** Dirección que se pega en el panel del proveedor para que nos avise (webhook); null si el servicio no la usa. */
  webhook_url: string | null;
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
  /** Empresas a las que pertenece (M3.6). */
  companies: CompanyRef[];
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
  /** Importar y exportar CSV (M3.5): solo el administrador. */
  import: boolean;
  export: boolean;
}

export type ImportStatus = 'staging' | 'ready' | 'running' | 'done' | 'cancelled';
export interface ImportOptions {
  duplicates: 'skip' | 'update_empty';
  country_prefix: string;
  consent: 'unknown' | 'granted';
  tag_id: string | null;
  owner_id: string | null;
}
/** Una importación de contactos desde CSV (M3.5, ADR-47). */
export interface ContactImport {
  id: string;
  file_name: string;
  status: ImportStatus;
  total_rows: number;
  staged_rows: number;
  headers: string[];
  mapping: string[];
  options: ImportOptions;
  counts: { created: number; updated: number; skipped: number; rejected: number; pending: number };
  legal_basis_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
export interface ImportPreview {
  total: number;
  new: number;
  duplicates_existing: number;
  duplicates_in_file: number;
  invalid: number;
  samples: Array<{ row_no: number; reasons: string[] }>;
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

// ── Etiquetas personalizadas, listas y filtros (M3.4, ADR-46) ──
export interface TagList {
  items: ContactTag[];
  /** `manage`: puede crear, renombrar y borrar etiquetas personalizadas. */
  access: { manage: boolean };
}
/** Filtros guardados de una lista dinámica (los mismos que acepta el listado). */
export interface SavedFilters {
  q?: string;
  owner?: string;
  source?: string;
  consent?: Consent;
  tag?: string[];
  cf?: string[];
}
export interface SavedList {
  id: string;
  name: string;
  kind: 'dynamic' | 'fixed';
  filters: SavedFilters;
  columns: string[] | null;
  sort: { key: 'created_at' | 'updated_at' | 'name'; order: 'asc' | 'desc' } | null;
  shared: boolean;
  /** ¿Es mía? Si no, otra persona la compartió. */
  mine: boolean;
  /** Contactos de una lista fija que YO puedo ver; null en las dinámicas. */
  member_count: number | null;
  created_at: string;
  updated_at: string;
}

// ── Empresas, notas y tareas (M3.6, ADR-48) ──
export interface CompanyRef {
  id: string;
  name: string;
}
export interface CrmCompany extends CompanyRef {
  website: string | null;
  phone: string | null;
  email: string | null;
  /** Contactos vinculados que esta persona puede ver. */
  contact_count: number;
  created_at: string;
  updated_at: string;
}
export interface CrmCompanyList {
  items: CrmCompany[];
  next_cursor: string | null;
  /** `manage`: crear, editar, borrar empresas y vincular contactos (administrador). `write`: notas y tareas de la empresa. */
  access: { manage: boolean; write: boolean };
}
export interface CrmCompanyContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}
export interface Note {
  id: string;
  body: string;
  author: { id: string; name: string };
  edited_at: string | null;
  created_at: string;
  can_edit: boolean;
  can_delete: boolean;
}
export interface Task {
  id: string;
  title: string;
  description: string | null;
  due_at: string | null;
  status: 'open' | 'done';
  completed_at: string | null;
  assignee: { id: string; name: string };
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  created_by: string;
  overdue: boolean;
  can_edit: boolean;
  can_complete: boolean;
  created_at: string;
  updated_at: string;
}
export interface TaskList {
  items: Task[];
  next_cursor: string | null;
  /** Solo en la primera página. */
  total: number | null;
  access: { view_all: boolean; write: boolean };
}

// ── Pipelines y etapas (M4.1, ADR-49) ──
export type StageKind = 'open' | 'won' | 'lost';
export type StageColor = 'blue' | 'teal' | 'violet' | 'amber' | 'green' | 'red' | 'pink' | 'gray';
export interface PipelineStage {
  id: string;
  name: string;
  position: number;
  kind: StageKind;
  is_hidden: boolean;
  color: StageColor;
  /** Oportunidades de la etapa que esta persona puede ver. */
  opportunity_count: number;
}
export interface Pipeline {
  id: string;
  name: string;
  position: number;
  appointment_stage_id: string | null;
  opportunity_count: number;
  /** También las etapas ocultas. */
  stages: PipelineStage[];
}
export interface PipelineList {
  items: Pipeline[];
  /** `manage`: configurar pipelines y etapas (administrador). `write`: operar oportunidades. `view_all`: ve las oportunidades de todos. */
  access: { manage: boolean; write: boolean; view_all: boolean };
}

// ── Oportunidades (M4.2, ADR-49) ──
export interface OpportunityContact {
  id: string;
  name: string;
  email: string | null;
  /** Teléfono principal. */
  phone: string | null;
  source: string;
  tags: ContactTag[];
}
export interface Opportunity {
  id: string;
  pipeline_id: string;
  stage_id: string;
  status: StageKind;
  /** Texto con 2 decimales («1500.00»): el dinero no pasa por flotantes. */
  amount: string;
  currency: string;
  owner: { id: string; name: string } | null;
  lost_reason: string | null;
  closed_at: string | null;
  stage_entered_at: string;
  created_at: string;
  contact: OpportunityContact;
}
export interface OpportunityHistoryEntry {
  id: string;
  at: string;
  from_stage: { id: string; name: string } | null;
  to_stage: { id: string; name: string };
  user: { id: string; name: string } | null;
  origin: string;
}
export interface OpportunityDetail extends Opportunity {
  history: OpportunityHistoryEntry[];
}
export interface OpportunityPage {
  items: Opportunity[];
  next_cursor: string | null;
  access: { write: boolean; view_all: boolean };
}
export interface StageSummary {
  stage_id: string;
  count: number;
  total: string;
}

// ── Conexiones de canales (M5.1, ADR-50) ──
export interface Channel {
  id: string;
  provider: 'meta_cloud';
  /** WhatsApp oficial (API de Meta). Las conexiones por QR (no oficiales) llegarán en otro hito. */
  is_official: boolean;
  name: string;
  status: 'active' | 'disabled';
  /** Cola por defecto: a dónde van las conversaciones nuevas de este número. */
  queue_id: string | null;
  waba_id: string;
  phone_number_id: string;
  display_phone: string | null;
  verified_name: string | null;
  /** Últimos 4 caracteres del token; el valor completo no se puede leer jamás. */
  token_last4: string | null;
  last_check_at: string | null;
  last_error: string | null;
  /** Última vez que Meta avisó de algo de este número (mensaje o estado): sirve para saber si el webhook está llegando. */
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ChannelList {
  items: Channel[];
  /** `false`: la plataforma aún no tiene la clave de cifrado y no se pueden guardar conexiones. */
  vault: { available: boolean };
}
export interface ChannelInput {
  name: string;
  waba_id: string;
  phone_number_id: string;
  access_token: string;
  /** Cola por defecto (opcional). */
  queue_id?: string | null;
}

// ── Colas y reparto (M5.3, ADR-07) ──
export type QueueMode = 'equal' | 'weighted' | 'load';
export interface QueueMember {
  user_id: string;
  name: string;
  role: string;
  active: boolean;
  weight: number;
  /** Conversaciones abiertas que atiende ahora. */
  open_count: number;
  /** Conversaciones que recibió hoy de esta cola. */
  today_count: number;
}
export interface Queue {
  id: string;
  name: string;
  color: string;
  distribution_on: boolean;
  mode: QueueMode;
  batch: number;
  daily_cap: number;
  only_unassigned: boolean;
  /** Con «respetar el horario» la cola no reparte mientras está cerrada: las conversaciones esperan «sin asignar» y se reparten al abrir (M5.5b). */
  respect_hours: boolean;
  /** Minutos de horario laboral sin respuesta tras los cuales se reasigna a otra persona de la cola; 0 = no reasigna. */
  reassign_minutes: number;
  /** Cuántas veces se reasigna una conversación como máximo. */
  max_rotations: number;
  /** Horario propio de la cola (siempre los siete días); null = usa el de la empresa. */
  hours: WeekHours | null;
  /** ¿La cola está abierta ahora (con su horario o el de la empresa)? */
  open_now: boolean;
  /** Todas las personas que pueden recibir trabajo, con su estado en ESTA cola. */
  members: QueueMember[];
  /** Conexiones cuya cola por defecto es esta. */
  channels: Array<{ id: string; name: string }>;
  unassigned_count: number;
  created_at: string;
  updated_at: string;
}
export interface QueueList {
  items: Queue[];
  limits: { max_queues: number };
}
export interface QueueSimulation {
  sequence: Array<{ user_id: string; name: string }>;
  counts: Array<{ user_id: string; name: string; count: number }>;
  stopped_early: boolean;
}
export interface QueueSettings {
  name?: string;
  color?: string;
  distribution_on?: boolean;
  mode?: QueueMode;
  batch?: number;
  daily_cap?: number;
  only_unassigned?: boolean;
  respect_hours?: boolean;
  reassign_minutes?: number;
  max_rotations?: number;
}
export interface QueueMemberInput {
  user_id: string;
  active: boolean;
  weight: number;
}

// ── SLA, horario laboral y feriados (M5.5b, ADR-07/50) ──
export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
/** Tramos «HH:MM»–«HH:MM» de un día; un día sin tramos está cerrado. */
export type DayHours = Array<[string, string]>;
/** El horario semanal tal como lo devuelve la API: siempre los siete días. */
export type WeekHours = Record<WeekdayKey, DayHours>;
export interface Holiday {
  id: string;
  /** AAAA-MM-DD. */
  date: string;
  name: string;
  yearly: boolean;
}
export interface SlaSettings {
  policy: { target_minutes: number; risk_minutes: number };
  /** Horario de la empresa; null = abierta siempre. */
  hours: WeekHours | null;
  holidays: Holiday[];
  time_zone: string;
  open_now: boolean;
}
/** Estado del cronómetro de respuesta de una conversación. */
export type SlaState = 'ok' | 'risk' | 'late' | 'paused' | 'done';
export interface ConversationSla {
  kind: 'first' | 'followup';
  state: SlaState;
  started_at: string;
  /** Fecha límite en tiempo abierto; null cuando ya se respondió. */
  due_at: string | null;
  /** Cuánto tardó en responder (tiempo abierto), si ya se respondió. */
  response_seconds: number | null;
}

// ── Inbox (M5.4, ADR-16/50) ──
export type ConversationStatus = 'unassigned' | 'pending' | 'working' | 'waiting' | 'closed';
/** Pestañas: `working` = trabajando y esperando al cliente · `pending` = «Pendientes»: por aceptar (y sin asignar para quien ve todo) · `closed` = finalizadas. */
export type InboxTab = 'working' | 'pending' | 'closed';
/** Cómo se relaciona quien consulta con la conversación: dueño, colaborador (con o sin permiso de responder) o supervisor (la ve porque ve todo). */
export type MyAccess = 'owner' | 'collaborator_reply' | 'collaborator_view' | 'supervisor';
/** Una persona con acceso a la conversación además de su dueño (M5.5, ADR-14). */
export interface Participant {
  user: { id: string; name: string };
  permission: 'reply' | 'view';
  added_by: { id: string; name: string } | null;
  added_at: string;
}
export interface Conversation {
  id: string;
  status: ConversationStatus;
  unread_count: number;
  last_message_at: string | null;
  last_inbound_at: string | null;
  assigned_at: string | null;
  closed_at: string | null;
  created_at: string;
  contact: { id: string; name: string; phone: string | null };
  owner: { id: string; name: string } | null;
  participants: Participant[];
  my_access: MyAccess;
  queue: { id: string; name: string; color: string } | null;
  channel: { id: string; name: string; state: 'active' | 'disabled' | 'removed' };
  tags: ContactTag[];
  last_message: { direction: 'in' | 'out'; kind: string; preview: string; status: string; at: string } | null;
  /** Ventana de 24 h de WhatsApp oficial para escribir libremente al cliente. */
  window: { open: boolean; expires_at: string | null };
  /** Lo que la persona puede hacer; es solo ayuda de presentación, el servidor vuelve a verificarlo. */
  can: { reply: boolean; note: boolean; accept: boolean; take: boolean; close: boolean; transfer: boolean; share: boolean };
  /** El cronómetro de respuesta; null si no hay nada que medir (sin asignar, o finalizada sin respuesta). */
  sla: ConversationSla | null;
}
export interface ConversationList {
  items: Conversation[];
  next_cursor: string | null;
  /** Solo en la primera página. */
  counts: { working: number; pending: number; closed: number; unread: number } | null;
}
export type MessageStatus = 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'internal';
export interface ChatMessage {
  id: string;
  direction: 'in' | 'out';
  sender_type: string;
  author: { id: string; name: string } | null;
  kind: string;
  text: string | null;
  media: { mime_type: string | null; filename: string | null } | null;
  extra: Record<string, unknown> | null;
  /** Reacción del cliente a este mensaje (un emoji), o null. */
  reaction: string | null;
  status: MessageStatus;
  error: string | null;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  is_note: boolean;
}
export interface ChatMessagePage {
  /** De la más antigua a la más reciente. */
  items: ChatMessage[];
  /** Para pedir los más antiguos; null si ya no hay más. */
  next_cursor: string | null;
}
/** Una persona a la que se puede transferir o con la que se puede compartir (M5.5). `in_queue` null = la conversación no tiene cola. */
export interface PersonOption {
  id: string;
  name: string;
  role: string;
  open_count: number;
  in_queue: boolean | null;
  is_owner: boolean;
  is_self: boolean;
  collaborator: 'reply' | 'view' | null;
}
export interface TransferOptions {
  items: PersonOption[];
  queue: { id: string; name: string } | null;
  can: { transfer: boolean; share: boolean };
}
export interface TransferResult {
  id: string;
  status: ConversationStatus;
  owner: { id: string; name: string };
  /** ¿Quien la transfirió sigue viéndola? */
  still_visible: boolean;
}
export interface RevokeResult {
  id: string;
  user_id: string;
  revoked: true;
  still_visible: boolean;
}
export interface InboxOptions {
  queues: Array<{ id: string; name: string; color: string }>;
  channels: Array<{ id: string; name: string; state: 'active' | 'disabled' }>;
  /** Solo para quien ve todas las conversaciones. */
  owners: Array<{ id: string; name: string }>;
  tags: ContactTag[];
}
export interface InboxFilters {
  tab: InboxTab;
  q: string;
  owner: string;
  queue: string;
  channel: string;
  tag: string;
  unread: boolean;
  /** Por el cronómetro de respuesta: `late` vencidas · `risk` en riesgo · `ok` al día; vacío = todas. */
  sla: '' | 'late' | 'risk' | 'ok';
}
