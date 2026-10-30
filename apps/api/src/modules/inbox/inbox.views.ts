import type { messages } from '../../db';
import type { SlaView } from '../sla';
import type { TagView } from '../tags';
import { abilities, myAccessOf, windowOf, type Abilities, type ChannelState, type Collab, type ConversationRow, type InboxScope, type MyAccess, type WindowState } from './inbox.access';

export type ConversationStatus = 'unassigned' | 'pending' | 'working' | 'waiting' | 'closed';

export interface LastMessageView {
  direction: 'in' | 'out';
  kind: string;
  /** Una línea: el comienzo del texto o, si no hay texto, el tipo de contenido («Imagen», «Audio»…). */
  preview: string;
  status: string;
  at: string;
}

/** Una persona con acceso a la conversación además de su dueño (M5.5, ADR-14). */
export interface ParticipantView {
  user: { id: string; name: string };
  /** `reply` puede responder (cuando el dueño ya la aceptó); `view` solo ve y deja notas. */
  permission: 'reply' | 'view';
  added_by: { id: string; name: string } | null;
  added_at: string;
}

export interface ConversationView {
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
  /** Quienes la comparten con su dueño (colaboradores con acceso vigente). */
  participants: ParticipantView[];
  /** Cómo se relaciona quien consulta con ella: dueño, colaborador (con o sin permiso de responder) o supervisor (la ve porque ve todo). */
  my_access: MyAccess;
  queue: { id: string; name: string; color: string } | null;
  channel: { id: string; name: string; state: ChannelState; kind: 'whatsapp' | 'ghl' | 'qr'; /** Solo WhatsApp por QR: `open` · `connecting` (no es una caída) · `down` (hay que volver a escanear el QR). */ session?: 'open' | 'connecting' | 'down' };
  tags: TagView[];
  /** El último mensaje real (las notas internas no cuentan). */
  last_message: LastMessageView | null;
  /** Ventana de 24 h de WhatsApp oficial para escribir libremente. */
  window: WindowState;
  /** El cronómetro de respuesta (M5.5b): en regla, en riesgo, vencido, en pausa fuera de horario o ya respondido; null si no hay medición. */
  sla: SlaView | null;
  /** Qué puede hacer quien consulta; la interfaz solo lo muestra, cada acción lo vuelve a verificar. */
  can: Abilities;
}

export interface MessageView {
  id: string;
  direction: 'in' | 'out';
  sender_type: string;
  author: { id: string; name: string } | null;
  kind: string;
  text: string | null;
  /** Adjunto entrante: solo la referencia; hasta M5.6 no se descarga. */
  media: { mime_type: string | null; filename: string | null } | null;
  /** Adjunto asociado (M5.6d): su estado y URL firmada si está listo. Null si no hay adjunto. */
  attachment: AttachmentInfo | null;
  /** Datos propios del tipo (ubicación, cantidad de contactos…). */
  extra: Record<string, unknown> | null;
  /** Reacción del cliente a este mensaje (un emoji), o null. */
  reaction: string | null;
  /** Reacción NUESTRA a este mensaje del cliente (M5.8), o null. */
  my_reaction: string | null;
  status: string;
  error: string | null;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  is_note: boolean;
  /** Si es una plantilla (M5.6a): cuál y sus botones. El texto armado va en `text`. */
  template: { name: string; language: string; category: string; buttons: Array<{ type: string; text: string; url: string | null; phone: string | null }> } | null;
}

export interface AttachmentInfo {
  id: string;
  kind: string;
  mime_type: string;
  filename: string | null;
  size_bytes: number | null;
  scan_status: string;
  error: string | null;
  url: string | null;
  expires_at: string | null;
}

export function attachmentInfo(row: { id: string; kind: string; mimeType: string; filename: string | null; sizeBytes: number | null; scanStatus: string; error: string | null }): AttachmentInfo {
  return { id: row.id, kind: row.kind, mime_type: row.mimeType, filename: row.filename, size_bytes: row.sizeBytes, scan_status: row.scanStatus, error: row.error, url: null, expires_at: null };
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  image: 'Imagen',
  audio: 'Audio',
  video: 'Video',
  document: 'Documento',
  sticker: 'Sticker',
  location: 'Ubicación',
  contacts: 'Contacto',
  interactive: 'Respuesta',
  button: 'Botón',
  template: 'Plantilla',
  unsupported: 'Mensaje no compatible',
};

/** Vista previa de una línea para el listado. */
export function previewOf(kind: string, body: string | null): string {
  const text = body?.replace(/\s+/g, ' ').trim() ?? '';
  if (text !== '') return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  return KIND_LABEL[kind] ?? 'Mensaje';
}

export interface ConversationParts {
  c: ConversationRow;
  contactName: string;
  phone: string | null;
  channelName: string;
  channelState: ChannelState;
  channelProvider: string;
  qrState: string | null;
  queue: { id: string; name: string; color: string } | null;
  owner: { id: string; name: string } | null;
  participants: ParticipantView[];
  /** Si quien consulta no es la dueña, su permiso como colaboradora. */
  collab: Collab;
  tags: readonly TagView[];
  sla: SlaView | null;
  last: { direction: string; kind: string; body: string | null; status: string; sentAt: Date } | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function conversationView(p: ConversationParts, scope: InboxScope, now: Date): ConversationView {
  const { c } = p;
  return {
    id: c.id,
    status: c.status as ConversationStatus,
    unread_count: c.unreadCount,
    last_message_at: iso(c.lastMessageAt),
    last_inbound_at: iso(c.lastInboundAt),
    assigned_at: iso(c.assignedAt),
    closed_at: iso(c.closedAt),
    created_at: c.createdAt.toISOString(),
    contact: { id: c.contactId, name: p.contactName, phone: p.phone },
    owner: p.owner,
    participants: p.participants,
    my_access: myAccessOf(scope, c, p.collab),
    queue: p.queue,
    channel: { id: c.channelAccountId, name: p.channelName, state: p.channelState, kind: p.channelProvider === 'ghl' ? 'ghl' : p.channelProvider === 'evolution' ? 'qr' : 'whatsapp', ...(p.qrState === null ? {} : { session: p.qrState === 'open' ? ('open' as const) : p.qrState === 'connecting' || p.qrState === 'created' ? ('connecting' as const) : ('down' as const) }) },
    tags: [...p.tags],
    last_message: p.last ? { direction: p.last.direction as 'in' | 'out', kind: p.last.kind, preview: previewOf(p.last.kind, p.last.body), status: p.last.status, at: p.last.sentAt.toISOString() } : null,
    window: windowOf(c.lastInboundAt, now, p.channelProvider),
    sla: p.sla,
    can: abilities(scope, c, p.channelState, p.collab),
  };
}

type MessageRow = typeof messages.$inferSelect;

/** `wa_id`, el código del último error de envío y la hora de la reacción son de uso interno: no se muestran (la reacción se muestra aparte). */
const HIDDEN_META = new Set(['wa_id', 'error_code', 'reaction', 'reaction_at', 'my_reaction', 'my_reaction_at', 'template', 'auto', 'ghl_type']);

/** De lo que guarda una plantilla enviada, solo lo que se muestra (nunca los datos de envío). */
function templateOf(meta: Record<string, unknown>): MessageView['template'] {
  const t = meta['template'];
  if (t === null || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  if (typeof o['name'] !== 'string' || typeof o['language'] !== 'string') return null;
  const buttons = Array.isArray(o['buttons']) ? (o['buttons'] as Array<Record<string, unknown>>) : [];
  return {
    name: o['name'],
    language: o['language'],
    category: typeof o['category'] === 'string' ? o['category'] : 'other',
    buttons: buttons.map((b) => ({ type: typeof b['type'] === 'string' ? b['type'] : 'other', text: typeof b['text'] === 'string' ? b['text'] : '', url: typeof b['url'] === 'string' ? b['url'] : null, phone: typeof b['phone'] === 'string' ? b['phone'] : null })),
  };
}

export function messageView(m: MessageRow, author: { id: string; name: string } | null, attachment: MessageView['attachment'] = null): MessageView {
  const media = m.media as { mime_type?: unknown; filename?: unknown } | null;
  const extra = Object.fromEntries(Object.entries(m.meta).filter(([k]) => !HIDDEN_META.has(k)));
  return {
    id: m.id,
    direction: m.direction as 'in' | 'out',
    sender_type: m.senderType,
    author,
    kind: m.kind,
    text: m.body,
    media: media ? { mime_type: typeof media.mime_type === 'string' ? media.mime_type : null, filename: typeof media.filename === 'string' ? media.filename : null } : null,
    attachment,
    extra: Object.keys(extra).length > 0 ? extra : null,
    reaction: typeof m.meta['reaction'] === 'string' ? m.meta['reaction'] : null,
    my_reaction: typeof m.meta['my_reaction'] === 'string' ? m.meta['my_reaction'] : null,
    status: m.status,
    error: m.error,
    sent_at: m.sentAt.toISOString(),
    delivered_at: iso(m.deliveredAt),
    read_at: iso(m.readAt),
    is_note: m.kind === 'note',
    template: m.kind === 'template' ? templateOf(m.meta) : null,
  };
}
