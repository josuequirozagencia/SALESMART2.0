import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { agentChannels, agentDocuments, agents, channelAccounts, Database, knowledgeDocuments, queues, type TenantTx } from '../../../db';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../../errors';
import { TenantContext } from '../../../tenant';
import { writeAudit } from '../../audit';
import { AttachmentsService, sniff, StorageError, StorageGateway } from '../../attachments';
import { ContactsService } from '../../contacts';
import { CustomValuesService } from '../../custom-fields';
import { OrgDirectoryService } from '../../organizations';
import { AiModelPricesService } from '../../platform';
import { customKeysIn, type ResolveContext } from '../../quick-replies';
import { MAX_CHUNKS_PER_AGENT } from '../knowledge/vector-store';
import { AGENT_BUILT_IN, composePrompt, COVERS, unknownAgentVariables, type Cover } from './agent-prompt';
import type { CreateAgentDto, PreviewDto, UpdateAgentDto } from './agents.dto';

export const MAX_AGENTS = 20;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_URL_TTL_SECONDS = 300;
const PHOTO_TYPES: Readonly<Record<string, { mime: string; ext: string }>> = { jpeg: { mime: 'image/jpeg', ext: 'jpg' }, png: { mime: 'image/png', ext: 'png' }, webp: { mime: 'image/webp', ext: 'webp' } };
const MIME_BY_EXT: Readonly<Record<string, string>> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const SAMPLE_CONTACT = { name: 'Ana Torres', custom: {} as Record<string, never> };

type Row = typeof agents.$inferSelect;

export interface AgentCard {
  id: string;
  name: string;
  role: string | null;
  /** URL firmada de la foto (vale unos minutos); null si no tiene o el almacenamiento no respondió. */
  photo_url: string | null;
  cover: Cover;
  active: boolean;
  model: string;
  channels: Array<{ id: string; name: string }>;
  documents: number;
  /** Fragmentos que suman sus documentos (el tope es el de un agente). */
  chunks: number;
  created_at: string;
}

export interface AgentDetail extends AgentCard {
  temperature: number;
  max_tokens: number;
  max_chars: number;
  personality: string;
  objective: string;
  extra_info: string;
  show_source: boolean;
  split_enabled: boolean;
  split_blocks: number;
  transfer_enabled: boolean;
  transfer_queue_id: string | null;
  always_on: boolean;
  document_ids: string[];
  channel_ids: string[];
  /** Qué le falta para poder responder (la pantalla lo muestra como lista de pendientes). */
  readiness: { instructions: boolean; documents: boolean; channel: boolean };
  updated_at: string;
}

export interface AgentOptions {
  /** Modelos de chat que se pueden elegir (solo nombres: los precios son de la plataforma). */
  models: string[];
  covers: readonly Cover[];
  limits: { max_agents: number; max_photo_bytes: number; max_chunks: number };
  /** Variables que se pueden usar en las instrucciones. */
  variables: Array<{ key: string; label: string; example: string; kind: 'builtin' | 'custom' }>;
  channels: Array<{ id: string; name: string; provider: string; status: string; agent: { id: string; name: string } | null }>;
  queues: Array<{ id: string; name: string }>;
  documents: Array<{ id: string; name: string; status: string; chunk_count: number; active: boolean }>;
}

export interface PreviewView {
  /** El mensaje de sistema que recibiría el modelo, con las variables resueltas con el contacto elegido (o un ejemplo). */
  system: string;
  /** Variables que no se pudieron resolver con ese contacto. */
  missing: string[];
  /** Variables que no existen o no se permiten a un agente. */
  unknown: string[];
  contact: { id: string; name: string } | null;
}

/**
 * Agentes de IA de la empresa (M8.3, ADR-20/53): galería, ajustes en cinco pestañas, foto, documentos asignados, conexiones y vista previa de las instrucciones. Todo bajo el TenantContext de la
 * empresa (RLS) y solo para quien administra agentes (`agents.manage`). El agente nace apagado y no puede activarse sin instrucciones; una conexión usa como máximo un agente; los documentos asignados
 * son de la misma empresa y suman, como mucho, `MAX_CHUNKS_PER_AGENT` fragmentos. Aún no responde mensajes (M8.5): aquí solo se configura.
 */
@Injectable()
export class AgentsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(StorageGateway) private readonly storage: StorageGateway,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(AiModelPricesService) private readonly prices: AiModelPricesService,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
  ) {}

  // ------------------------------------------------------------------ lectura

  async list(): Promise<{ items: AgentCard[]; limits: { max_agents: number } }> {
    const rows = await this.db.withTenant(async (tx) => {
      const list = await tx.select().from(agents).where(isNull(agents.deletedAt)).orderBy(asc(agents.createdAt), asc(agents.id));
      return Promise.all(list.map(async (r) => ({ row: r, ...(await this.relations(tx, r.id)) })));
    });
    return { items: await Promise.all(rows.map((r) => this.card(r.row, r))), limits: { max_agents: MAX_AGENTS } };
  }

  async get(id: string): Promise<AgentDetail> {
    const out = await this.db.withTenant(async (tx) => {
      const r = await this.byId(tx, id, false);
      return { row: r, ...(await this.relations(tx, id)) };
    });
    return this.detail(out.row, out);
  }

  /** Todo lo que la pantalla necesita para armar el formulario: modelos, paleta, variables, conexiones (con su agente), colas y la biblioteca. */
  async options(): Promise<AgentOptions> {
    const models = await this.prices.chatModels(); // plataforma: se lee ANTES de la transacción de negocio
    return this.db.withTenant(async (tx) => {
      const labels = await this.custom.labels(tx, 'contact');
      const orgAgents = await tx.select({ id: agents.id, name: agents.name }).from(agents).where(isNull(agents.deletedAt));
      const nameOf = new Map(orgAgents.map((a) => [a.id, a.name]));
      const channelRows = await tx.select({ id: channelAccounts.id, name: channelAccounts.name, provider: channelAccounts.provider, status: channelAccounts.status }).from(channelAccounts).where(isNull(channelAccounts.deletedAt)).orderBy(asc(channelAccounts.name));
      const used = await tx.select({ channelId: agentChannels.channelId, agentId: agentChannels.agentId }).from(agentChannels);
      const agentOf = new Map(used.map((u) => [u.channelId, u.agentId]));
      const q = await tx.select({ id: queues.id, name: queues.name }).from(queues).where(isNull(queues.deletedAt)).orderBy(asc(queues.name));
      const docs = await tx.select({ id: knowledgeDocuments.id, name: knowledgeDocuments.name, status: knowledgeDocuments.status, chunk_count: knowledgeDocuments.chunkCount, active: knowledgeDocuments.active }).from(knowledgeDocuments).where(isNull(knowledgeDocuments.deletedAt)).orderBy(asc(knowledgeDocuments.name));
      return {
        models,
        covers: COVERS,
        limits: { max_agents: MAX_AGENTS, max_photo_bytes: MAX_PHOTO_BYTES, max_chunks: MAX_CHUNKS_PER_AGENT },
        variables: [...AGENT_BUILT_IN.map((v) => ({ key: v.key, label: v.label, example: v.example, kind: 'builtin' as const })), ...labels.map((f) => ({ key: `contact.${f.key}`, label: f.name, example: '', kind: 'custom' as const }))],
        channels: channelRows.map((c) => {
          const agentId = agentOf.get(c.id);
          return { ...c, agent: agentId ? { id: agentId, name: nameOf.get(agentId) ?? '' } : null };
        }),
        queues: q,
        documents: docs,
      };
    });
  }

  // ------------------------------------------------------------------ crear, cambiar, borrar

  async create(input: CreateAgentDto): Promise<AgentDetail> {
    const models = await this.prices.chatModels();
    const model = input.model ?? models[0];
    if (!model || !models.includes(model)) throw new ValidationError([{ path: 'model', code: 'not_available', message: 'Ese modelo no está disponible' }]);
    const userId = TenantContext.current().userId ?? null;
    const row = await this.db
      .withTenant(async (tx) => {
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(agents).where(isNull(agents.deletedAt));
        if ((n?.n ?? 0) >= MAX_AGENTS) throw new ConflictError('AGENT_LIMIT', `Llegaste al máximo de ${MAX_AGENTS} agentes: borra alguno para crear otro`);
        const [r] = await tx.insert(agents).values({ name: input.name, role: input.role?.trim() || null, cover: input.cover ?? 'violet', model, createdBy: userId, createdAt: new Date(), updatedAt: new Date() }).returning();
        await writeAudit(tx, { entityType: 'agent', entityId: r!.id, newValue: { name: r!.name, model }, source: 'manual' });
        return r!;
      })
      .catch((e: unknown) => {
        throw this.taken(e) ?? e;
      });
    return this.get(row.id);
  }

  async update(id: string, patch: UpdateAgentDto): Promise<AgentDetail> {
    const models = patch.model !== undefined ? await this.prices.chatModels() : [];
    await this.db
      .withTenant(async (tx) => {
        const cur = await this.byId(tx, id, true);
        if (patch.model !== undefined && patch.model !== cur.model && !models.includes(patch.model)) throw new ValidationError([{ path: 'model', code: 'not_available', message: 'Ese modelo no está disponible' }]);
        if (patch.transfer_queue_id) {
          const [q] = await tx.select({ id: queues.id }).from(queues).where(and(eq(queues.id, patch.transfer_queue_id), isNull(queues.deletedAt))).limit(1);
          if (!q) throw new ValidationError([{ path: 'transfer_queue_id', code: 'not_found', message: 'La cola no existe' }]);
        }
        await this.assertVariables(tx, { personality: patch.personality ?? cur.personality, objective: patch.objective ?? cur.objective, extra_info: patch.extra_info ?? cur.extraInfo });
        const next = { personality: patch.personality ?? cur.personality, objective: patch.objective ?? cur.objective };
        if (patch.active === true && !cur.active && next.personality.trim() === '' && next.objective.trim() === '') throw new ConflictError('AGENT_INCOMPLETE', 'Escribe la personalidad o el objetivo del agente antes de activarlo');
        const set: Partial<typeof agents.$inferInsert> = { updatedAt: new Date() };
        const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        const note = (field: string, oldValue: unknown, newValue: unknown, set_: () => void): void => {
          if (oldValue === newValue) return;
          set_();
          changes.push({ field, oldValue, newValue });
        };
        const longText = (field: string, oldV: string, newV: string | undefined, assign: (v: string) => void): void => {
          if (newV === undefined || newV === oldV) return;
          assign(newV);
          changes.push({ field, oldValue: { length: oldV.length }, newValue: { length: newV.length } }); // el texto de las instrucciones no va a la auditoría: solo que cambió y su largo
        };
        if (patch.name !== undefined) note('name', cur.name, patch.name, () => (set.name = patch.name!));
        if (patch.role !== undefined) note('role', cur.role, patch.role?.trim() || null, () => (set.role = patch.role?.trim() || null));
        if (patch.cover !== undefined) note('cover', cur.cover, patch.cover, () => (set.cover = patch.cover!));
        if (patch.active !== undefined) note('active', cur.active, patch.active, () => (set.active = patch.active!));
        if (patch.model !== undefined) note('model', cur.model, patch.model, () => (set.model = patch.model!));
        if (patch.temperature !== undefined) note('temperature', Number(cur.temperature), patch.temperature, () => (set.temperature = patch.temperature!.toFixed(2)));
        if (patch.max_tokens !== undefined) note('max_tokens', cur.maxTokens, patch.max_tokens, () => (set.maxTokens = patch.max_tokens!));
        if (patch.max_chars !== undefined) note('max_chars', cur.maxChars, patch.max_chars, () => (set.maxChars = patch.max_chars!));
        longText('personality', cur.personality, patch.personality, (v) => (set.personality = v));
        longText('objective', cur.objective, patch.objective, (v) => (set.objective = v));
        longText('extra_info', cur.extraInfo, patch.extra_info, (v) => (set.extraInfo = v));
        if (patch.show_source !== undefined) note('show_source', cur.showSource, patch.show_source, () => (set.showSource = patch.show_source!));
        if (patch.split_enabled !== undefined) note('split_enabled', cur.splitEnabled, patch.split_enabled, () => (set.splitEnabled = patch.split_enabled!));
        if (patch.split_blocks !== undefined) note('split_blocks', cur.splitBlocks, patch.split_blocks, () => (set.splitBlocks = patch.split_blocks!));
        if (patch.transfer_enabled !== undefined) note('transfer_enabled', cur.transferEnabled, patch.transfer_enabled, () => (set.transferEnabled = patch.transfer_enabled!));
        if (patch.transfer_queue_id !== undefined) note('transfer_queue_id', cur.transferQueueId, patch.transfer_queue_id, () => (set.transferQueueId = patch.transfer_queue_id!));
        if (patch.always_on !== undefined) note('always_on', cur.alwaysOn, patch.always_on, () => (set.alwaysOn = patch.always_on!));
        if (changes.length === 0) return;
        await tx.update(agents).set(set).where(eq(agents.id, id));
        for (const c of changes) await writeAudit(tx, { entityType: 'agent', entityId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: 'manual' });
      })
      .catch((e: unknown) => {
        throw this.taken(e) ?? e;
      });
    return this.get(id);
  }

  /** Borrado lógico: el agente deja de existir, suelta sus conexiones y documentos y se borra su foto. */
  async remove(id: string): Promise<{ id: string; deleted: true }> {
    const photoKey = await this.db.withTenant(async (tx) => {
      const cur = await this.byId(tx, id, true);
      await tx.delete(agentChannels).where(eq(agentChannels.agentId, id));
      await tx.delete(agentDocuments).where(eq(agentDocuments.agentId, id));
      await tx.update(agents).set({ deletedAt: new Date(), active: false, photoKey: null, updatedAt: new Date() }).where(eq(agents.id, id));
      await writeAudit(tx, { entityType: 'agent', entityId: id, field: 'deleted', oldValue: false, newValue: { deleted: true, name: cur.name }, source: 'manual' });
      return cur.photoKey;
    });
    if (photoKey) await this.storage.delete(photoKey).catch(() => undefined);
    return { id, deleted: true };
  }

  // ------------------------------------------------------------------ documentos y conexiones

  /** Reemplaza los documentos del agente por esta lista. Todos deben ser de la empresa y vigentes; entre todos no pueden pasar de `MAX_CHUNKS_PER_AGENT` fragmentos. */
  async setDocuments(id: string, documentIds: readonly string[]): Promise<AgentDetail> {
    const ids = [...new Set(documentIds)];
    await this.db.withTenant(async (tx) => {
      await this.byId(tx, id, true);
      const docs = ids.length === 0 ? [] : await tx.select({ id: knowledgeDocuments.id, chunks: knowledgeDocuments.chunkCount }).from(knowledgeDocuments).where(and(inArray(knowledgeDocuments.id, ids), isNull(knowledgeDocuments.deletedAt)));
      if (docs.length !== ids.length) throw new ValidationError([{ path: 'document_ids', code: 'not_found', message: 'Alguno de los documentos no existe' }]);
      const total = docs.reduce((n, d) => n + d.chunks, 0);
      if (total > MAX_CHUNKS_PER_AGENT) throw new ConflictError('AGENT_CHUNK_LIMIT', `Los documentos elegidos suman ${total.toLocaleString('es-EC')} fragmentos y un agente puede usar hasta ${MAX_CHUNKS_PER_AGENT.toLocaleString('es-EC')}: quita alguno`);
      const before = (await tx.select({ d: agentDocuments.documentId }).from(agentDocuments).where(eq(agentDocuments.agentId, id))).map((r) => r.d).sort();
      const after = [...ids].sort();
      if (before.join() === after.join()) return;
      await tx.delete(agentDocuments).where(eq(agentDocuments.agentId, id));
      if (ids.length > 0) await tx.insert(agentDocuments).values(ids.map((documentId) => ({ agentId: id, documentId })));
      await tx.update(agents).set({ updatedAt: new Date() }).where(eq(agents.id, id));
      await writeAudit(tx, { entityType: 'agent', entityId: id, field: 'documents', oldValue: before, newValue: after, source: 'manual' });
    });
    return this.get(id);
  }

  /** Reemplaza las conexiones del agente. **Una conexión usa como máximo UN agente**: si ya la tiene otro, 409 con su nombre. */
  async setChannels(id: string, channelIds: readonly string[]): Promise<AgentDetail> {
    const ids = [...new Set(channelIds)];
    await this.db
      .withTenant(async (tx) => {
        await this.byId(tx, id, true);
        const found = ids.length === 0 ? [] : await tx.select({ id: channelAccounts.id }).from(channelAccounts).where(and(inArray(channelAccounts.id, ids), isNull(channelAccounts.deletedAt)));
        if (found.length !== ids.length) throw new ValidationError([{ path: 'channel_ids', code: 'not_found', message: 'Alguna de las conexiones no existe' }]);
        if (ids.length > 0) {
          const taken = await tx
            .select({ name: agents.name })
            .from(agentChannels)
            .innerJoin(agents, and(eq(agents.id, agentChannels.agentId), eq(agents.organizationId, agentChannels.organizationId)))
            .where(and(inArray(agentChannels.channelId, ids), ne(agentChannels.agentId, id)))
            .limit(1);
          if (taken[0]) throw new ConflictError('CHANNEL_HAS_AGENT', `Una de esas conexiones ya la atiende el agente «${taken[0].name}»: quítasela primero`);
        }
        const before = (await tx.select({ c: agentChannels.channelId }).from(agentChannels).where(eq(agentChannels.agentId, id))).map((r) => r.c).sort();
        const after = [...ids].sort();
        if (before.join() === after.join()) return;
        await tx.delete(agentChannels).where(eq(agentChannels.agentId, id));
        if (ids.length > 0) await tx.insert(agentChannels).values(ids.map((channelId) => ({ agentId: id, channelId })));
        await tx.update(agents).set({ updatedAt: new Date() }).where(eq(agents.id, id));
        await writeAudit(tx, { entityType: 'agent', entityId: id, field: 'channels', oldValue: before, newValue: after, source: 'manual' });
      })
      .catch((e: unknown) => {
        // Dos personas a la vez: el índice único por conexión lo detiene
        if ((e as { cause?: { code?: string } }).cause?.code === '23505') throw new ConflictError('CHANNEL_HAS_AGENT', 'Una de esas conexiones ya la atiende otro agente');
        throw e;
      });
    return this.get(id);
  }

  // ------------------------------------------------------------------ foto

  /** Sube la foto (JPEG, PNG o WebP de hasta 2 MB). El tipo se decide por el contenido; el antivirus (si hay) la revisa; la anterior se borra. */
  async setPhoto(id: string, bytes: Buffer): Promise<AgentDetail> {
    if (bytes.length === 0) throw new AppError(400, 'AGENT_PHOTO_EMPTY', 'El archivo está vacío');
    if (bytes.length > MAX_PHOTO_BYTES) throw new AppError(413, 'AGENT_PHOTO_TOO_LARGE', `La foto pesa demasiado: el máximo es ${Math.floor(MAX_PHOTO_BYTES / (1024 * 1024))} MB`);
    const type = PHOTO_TYPES[sniff(bytes) ?? ''];
    if (!type) throw new AppError(415, 'AGENT_PHOTO_UNSUPPORTED', 'La foto debe ser una imagen JPEG, PNG o WebP');
    await this.db.withTenant((tx) => this.byId(tx, id, false)); // 404 antes de gastar antivirus y almacenamiento
    if ((await this.attachments.scan(bytes)) === 'infected') throw new AppError(422, 'ATTACHMENT_INFECTED', 'El antivirus detectó un virus en el archivo: no se puede usar');
    const organizationId = TenantContext.current().organizationId;
    const key = `org/${organizationId}/agents/${id}/${randomUUID()}.${type.ext}`;
    try {
      await this.storage.put(key, bytes, type.mime);
    } catch (e) {
      if (e instanceof StorageError) throw new AppError(503, e.code === 'not_configured' ? 'STORAGE_NOT_CONFIGURED' : 'STORAGE_UNAVAILABLE', e.message);
      throw e;
    }
    let old: string | null;
    try {
      old = await this.db.withTenant(async (tx) => {
        const cur = await this.byId(tx, id, true);
        await tx.update(agents).set({ photoKey: key, updatedAt: new Date() }).where(eq(agents.id, id));
        await writeAudit(tx, { entityType: 'agent', entityId: id, field: 'photo', oldValue: cur.photoKey !== null, newValue: true, source: 'manual' });
        return cur.photoKey;
      });
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined); // no queda un archivo sin agente
      throw e;
    }
    if (old) await this.storage.delete(old).catch(() => undefined);
    return this.get(id);
  }

  async removePhoto(id: string): Promise<AgentDetail> {
    const old = await this.db.withTenant(async (tx) => {
      const cur = await this.byId(tx, id, true);
      if (cur.photoKey === null) return null;
      await tx.update(agents).set({ photoKey: null, updatedAt: new Date() }).where(eq(agents.id, id));
      await writeAudit(tx, { entityType: 'agent', entityId: id, field: 'photo', oldValue: true, newValue: false, source: 'manual' });
      return cur.photoKey;
    });
    if (old) await this.storage.delete(old).catch(() => undefined);
    return this.get(id);
  }

  // ------------------------------------------------------------------ vista previa

  /**
   * Cómo quedarían las instrucciones: el mensaje de sistema que recibiría el modelo, con las variables resueltas con un contacto real (de los que la persona ve) o con un ejemplo, y los avisos de lo que
   * falta o no existe. Parte de los valores guardados del agente (`agent_id`) y los sustituye por lo que se mande, para previsualizar ANTES de guardar. No gasta créditos ni llama a la IA.
   */
  async preview(input: PreviewDto): Promise<PreviewView> {
    const orgName = await this.directory.organizationName(); // identidad: ANTES de la transacción de negocio
    return this.db.withTenant(async (tx) => {
      const saved = input.agent_id ? await this.byId(tx, input.agent_id, false) : null;
      const texts = { personality: input.personality ?? saved?.personality ?? '', objective: input.objective ?? saved?.objective ?? '', extra_info: input.extra_info ?? saved?.extraInfo ?? '' };
      const active = new Set((await this.custom.labels(tx, 'contact')).map((f) => f.key));
      const unknown = [...new Set(Object.values(texts).flatMap((t) => unknownAgentVariables(t, active)))];
      let contact: PreviewView['contact'] = null;
      let name: string = SAMPLE_CONTACT.name;
      let values: ResolveContext['custom'] = SAMPLE_CONTACT.custom;
      if (input.contact_id) {
        const c = await this.contacts.visibleContactIn(tx, { viewAll: true }, input.contact_id); // quien administra agentes ve todos los contactos; 404 uniforme si no existe
        contact = { id: c.id, name: c.name };
        name = c.name;
        const wanted = new Set(Object.values(texts).flatMap((t) => customKeysIn(t)));
        const all = (await this.custom.valuesFor(tx, 'contact', [c.id])).get(c.id) ?? {};
        values = Object.fromEntries(Object.entries(all).filter(([k]) => wanted.has(k)));
      }
      const agentName = input.name ?? saved?.name ?? 'Tu agente';
      const out = composePrompt(
        { name: agentName, role: input.role !== undefined ? input.role : (saved?.role ?? null), personality: texts.personality, objective: texts.objective, extraInfo: texts.extra_info, showSource: input.show_source ?? saved?.showSource ?? false, maxChars: input.max_chars ?? saved?.maxChars ?? 800 },
        { contactName: name, contactPhone: null, agentName, orgName, custom: values },
      );
      return { system: out.system, missing: out.missing, unknown, contact };
    });
  }

  // ------------------------------------------------------------------ interno

  private async byId(tx: TenantTx, id: string, lock: boolean): Promise<Row> {
    const q = tx.select().from(agents).where(and(eq(agents.id, id), isNull(agents.deletedAt))).limit(1);
    const [r] = await (lock ? q.for('update') : q);
    if (!r) throw new NotFoundError();
    return r;
  }

  private async relations(tx: TenantTx, id: string): Promise<{ channels: Array<{ id: string; name: string }>; documentIds: string[]; chunks: number }> {
    const ch = await tx.select({ id: channelAccounts.id, name: channelAccounts.name }).from(agentChannels).innerJoin(channelAccounts, and(eq(channelAccounts.id, agentChannels.channelId), eq(channelAccounts.organizationId, agentChannels.organizationId))).where(eq(agentChannels.agentId, id)).orderBy(asc(channelAccounts.name));
    const docs = await tx.select({ id: knowledgeDocuments.id, chunks: knowledgeDocuments.chunkCount }).from(agentDocuments).innerJoin(knowledgeDocuments, and(eq(knowledgeDocuments.id, agentDocuments.documentId), eq(knowledgeDocuments.organizationId, agentDocuments.organizationId))).where(eq(agentDocuments.agentId, id));
    return { channels: ch, documentIds: docs.map((d) => d.id), chunks: docs.reduce((n, d) => n + d.chunks, 0) };
  }

  private async card(r: Row, rel: { channels: Array<{ id: string; name: string }>; documentIds: string[]; chunks: number }): Promise<AgentCard> {
    return { id: r.id, name: r.name, role: r.role, photo_url: await this.photoUrl(r.photoKey), cover: r.cover as Cover, active: r.active, model: r.model, channels: rel.channels, documents: rel.documentIds.length, chunks: rel.chunks, created_at: r.createdAt.toISOString() };
  }

  private async detail(r: Row, rel: { channels: Array<{ id: string; name: string }>; documentIds: string[]; chunks: number }): Promise<AgentDetail> {
    return {
      ...(await this.card(r, rel)),
      temperature: Number(r.temperature),
      max_tokens: r.maxTokens,
      max_chars: r.maxChars,
      personality: r.personality,
      objective: r.objective,
      extra_info: r.extraInfo,
      show_source: r.showSource,
      split_enabled: r.splitEnabled,
      split_blocks: r.splitBlocks,
      transfer_enabled: r.transferEnabled,
      transfer_queue_id: r.transferQueueId,
      always_on: r.alwaysOn,
      document_ids: rel.documentIds,
      channel_ids: rel.channels.map((c) => c.id),
      readiness: { instructions: r.personality.trim() !== '' || r.objective.trim() !== '', documents: rel.documentIds.length > 0, channel: rel.channels.length > 0 },
      updated_at: r.updatedAt.toISOString(),
    };
  }

  /** La URL firmada de la foto, o null (sin foto, o el almacenamiento no respondió: la tarjeta se ve igual, con las iniciales). */
  private async photoUrl(key: string | null): Promise<string | null> {
    if (!key) return null;
    const mime = MIME_BY_EXT[key.split('.').pop() ?? ''];
    if (!mime) return null;
    try {
      return await this.storage.signedUrl(key, { expiresInSeconds: PHOTO_URL_TTL_SECONDS, contentType: mime, disposition: 'inline', filename: null });
    } catch {
      return null;
    }
  }

  /** Rechaza las instrucciones que usan una variable que no existe o no se permite, diciendo cuál. */
  private async assertVariables(tx: TenantTx, texts: { personality: string; objective: string; extra_info: string }): Promise<void> {
    const active = new Set((await this.custom.labels(tx, 'contact')).map((f) => f.key));
    const issues: Array<{ path: string; code: string; message: string }> = [];
    for (const [path, text] of Object.entries(texts)) {
      for (const v of unknownAgentVariables(text, active)) issues.push({ path, code: 'unknown_variable', message: v === 'telefono' ? 'La variable «{{telefono}}» no se ofrece a los agentes: el teléfono del cliente no se envía a la IA' : `La variable «{{${v}}}» no existe. Usa las variables de la lista o un campo personalizado como {{contact.ciudad}}` });
    }
    if (issues.length > 0) throw new ValidationError(issues);
  }

  /** El nombre repetido (índice único por empresa) como 409 con un mensaje claro. */
  private taken(e: unknown): ConflictError | null {
    return (e as { cause?: { code?: string } }).cause?.code === '23505' ? new ConflictError('AGENT_EXISTS', 'Ya tienes un agente con ese nombre') : null;
  }
}
