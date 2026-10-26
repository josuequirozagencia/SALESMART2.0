import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { contactTags, contacts, Database, ghlConnections, ghlContactLinks, ghlEvents, ghlOutbox, tags as tagsTable, type TenantTx } from '../../db';
import { ValidationError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { ConversationsService, type NormalizedMessage } from '../conversations';
import type { AssignmentContext } from '../queues';
import type { OrgDirectory } from '../organizations';
import { ContactTaggingService } from '../tags';
import { GhlChannelService } from './ghl-channel.service';
import type { GhlEventPayload } from './ghl-event';

export const GHL_EVENT_BATCH = 20;
export const GHL_EVENT_MAX_ATTEMPTS = 5;
/** Cuántos días se conserva el contenido de un aviso ya procesado (provisional, ADR-52). Después queda solo el registro. */
export const GHL_PAYLOAD_RETENTION_DAYS = 30;
const REDACT_BATCH = 500;
const MAX_BACKOFF_MS = 10 * 60_000;

type EventRow = typeof ghlEvents.$inferSelect;
export type GhlEventStatus = 'pending' | 'done' | 'skipped' | 'failed';
type Outcome = 'contact_created' | 'contact_linked' | 'contact_updated' | 'contact_unchanged' | 'message_received';
type Processed = { status: 'done'; outcome: Outcome; contactId: string; note?: string | null } | { status: 'skipped'; note: string };

export interface GhlEventView {
  id: string;
  type: 'contact' | 'message_in';
  ghl_contact_id: string;
  status: GhlEventStatus;
  outcome: Outcome | null;
  note: string | null;
  contact: { id: string; name: string } | null;
  attempts: number;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
}

/** Etiqueta del error SIN su mensaje (podría llevar un teléfono o un correo): solo la clase y el código de la base de datos. */
function errorLabel(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : typeof (e as { code?: unknown } | null)?.code === 'string' ? ((e as { code: string }).code) : null;
  const name = e instanceof Error ? e.name : 'Error';
  return (code ? `${name}:${code}` : name).slice(0, 100);
}

/**
 * Avisos del Workflow de GoHighLevel de una empresa (M7.2, ADR-52). El webhook solo VALIDA y GUARDA el aviso (ya con su empresa) y responde 200; esta tarea lo aplica. Todo corre dentro del
 * TenantContext de la empresa que pone quien llama.
 *  - `store`: idempotente por clave (el `event_id` del Workflow o la huella del contenido en una ventana de 10 minutos).
 *  - `runDue`: `FOR UPDATE SKIP LOCKED`; cada aviso corre en su SAVEPOINT (si falla se revierte solo él), se reintenta con espera creciente y tras 5 intentos queda `failed`.
 *  - Un aviso de contacto crea o vincula el contacto por teléfono y COMPLETA su nombre y correo sin pisar lo que la empresa ya tiene. Los mensajes llegan en M7.4.
 */
@Injectable()
export class GhlEventsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(ContactTaggingService) private readonly tagging: ContactTaggingService,
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(GhlChannelService) private readonly channel: GhlChannelService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** Guarda el aviso. true = es nuevo; false = ya lo teníamos (reintento del Workflow). */
  async store(tx: TenantTx, e: GhlEventPayload, dedupeKey: string, now: Date): Promise<boolean> {
    const inserted = await tx
      .insert(ghlEvents)
      .values({
        dedupeKey,
        eventType: e.type,
        ghlContactId: e.ghlContactId,
        payload: { name: e.name, phone: e.phone, phone_invalid: e.phoneInvalid, email: e.email, tags: e.tags, message: e.message ? { id: e.message.id, text: e.message.text, type: e.message.type, sent_at: e.message.sentAt } : null },
        receivedAt: now,
        nextAttemptAt: now,
      })
      .onConflictDoNothing({ target: [ghlEvents.organizationId, ghlEvents.dedupeKey] })
      .returning({ id: ghlEvents.id });
    return inserted.length > 0;
  }

  /**
   * Procesa los avisos pendientes cuya hora ya llegó. Devuelve cuántos tomó (hechos o reprogramados). `dir` es lo de identidad que el reparto de un mensaje entrante necesita (zona horaria y quién puede
   * recibir trabajo): quien llama lo lee ANTES, porque dentro de la transacción de negocio no se puede tocar la identidad. Sin él, un aviso de mensaje se reintenta más tarde en vez de repartirse mal.
   */
  async runDue(now: Date, dir?: OrgDirectory, batch = GHL_EVENT_BATCH): Promise<number> {
    const assign: AssignmentContext | null = dir ? { now, timeZone: dir.timeZone, assignable: dir.assignable } : null;
    return this.db.withTenant(async (tx) => {
      const due = await tx
        .select()
        .from(ghlEvents)
        .where(and(eq(ghlEvents.status, 'pending'), lte(ghlEvents.nextAttemptAt, now)))
        .orderBy(asc(ghlEvents.receivedAt), asc(ghlEvents.id))
        .limit(batch)
        .for('update', { skipLocked: true });
      for (const ev of due) await this.processOne(tx, ev, now, assign);
      if (due.length < batch) await this.redactOld(tx, now);
      return due.length;
    });
  }

  private async processOne(tx: TenantTx, ev: EventRow, now: Date, assign: AssignmentContext | null): Promise<void> {
    const attempts = ev.attempts + 1;
    // SAVEPOINT en la misma transacción: si este aviso falla se revierte solo lo suyo y los demás avisos del lote siguen sanos
    await tx.execute(sql`SAVEPOINT ghl_event`);
    let failure: unknown = null;
    let result: Processed | null = null;
    try {
      result = await this.apply(tx, ev, now, assign);
      await tx.execute(sql`RELEASE SAVEPOINT ghl_event`);
    } catch (e) {
      failure = e;
      await tx.execute(sql`ROLLBACK TO SAVEPOINT ghl_event`);
    }
    if (failure === null && result) {
      if (result.status === 'done') await tx.update(ghlEvents).set({ status: 'done', outcome: result.outcome, contactId: result.contactId, attempts, processedAt: now, lastError: null, note: result.note ?? null }).where(eq(ghlEvents.id, ev.id));
      else await tx.update(ghlEvents).set({ status: 'skipped', note: result.note.slice(0, 200), attempts, processedAt: now, lastError: null }).where(eq(ghlEvents.id, ev.id));
      return;
    }
    const label = errorLabel(failure);
    this.log.warn({ event_id: ev.id, attempts, err: label }, 'aviso de GoHighLevel no se pudo procesar');
    if (attempts >= GHL_EVENT_MAX_ATTEMPTS) {
      await tx.update(ghlEvents).set({ status: 'failed', attempts, processedAt: now, lastError: label }).where(eq(ghlEvents.id, ev.id));
    } else {
      const wait = Math.min(2 ** attempts * 7_500, MAX_BACKOFF_MS);
      await tx.update(ghlEvents).set({ attempts, lastError: label, nextAttemptAt: new Date(now.getTime() + wait) }).where(eq(ghlEvents.id, ev.id));
    }
  }

  private async apply(tx: TenantTx, ev: EventRow, now: Date, assign: AssignmentContext | null): Promise<Processed> {
    // Un aviso sin contenido (ya vaciado) no tiene nada que procesar
    if (!ev.payload) return { status: 'skipped', note: 'El contenido del aviso ya se había vaciado' };
    const p = ev.payload as { name: string | null; phone: string | null; phone_invalid: boolean; email: string | null; tags?: string[] | null; message?: { id: string | null; text: string; type: string | null; sent_at: string | null } | null };
    const ghlId = ev.ghlContactId;

    // 1) ¿ya está vinculado? (y su contacto sigue vigente)
    const [link] = await tx.select().from(ghlContactLinks).where(eq(ghlContactLinks.ghlContactId, ghlId)).limit(1);
    let contactId: string | null = null;
    let outcome: Outcome | null = null;
    if (link) {
      const [c] = await tx.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, link.contactId), sql`${contacts.deletedAt} IS NULL`)).limit(1);
      contactId = c?.id ?? null;
    }
    // 2) si no, por teléfono (sin teléfono no hay forma segura de saber quién es)
    if (!contactId) {
      if (!p.phone) return { status: 'skipped', note: p.phone_invalid ? 'El teléfono no está en formato internacional (+código de país): no se pudo identificar al contacto' : 'El contacto de GoHighLevel no trae teléfono: no se pudo identificar' };
      const r = await this.contacts.findOrCreateByPhone(tx, p.phone, 'ghl', p.name, 'ghl');
      const [other] = await tx.select({ ghlContactId: ghlContactLinks.ghlContactId }).from(ghlContactLinks).where(eq(ghlContactLinks.contactId, r.id)).limit(1);
      if (other && other.ghlContactId !== ghlId) return { status: 'skipped', note: 'Ese teléfono ya pertenece a un contacto vinculado a otro contacto de GoHighLevel' };
      if (link) await tx.update(ghlContactLinks).set({ contactId: r.id }).where(eq(ghlContactLinks.id, link.id));
      else await tx.insert(ghlContactLinks).values({ ghlContactId: ghlId, contactId: r.id });
      contactId = r.id;
      outcome = r.created ? 'contact_created' : 'contact_linked';
    }
    // 3) completar nombre y correo sin pisar lo que ya hay
    const changed = await this.contacts.completeProfile(tx, contactId, { name: p.name, email: p.email }, 'ghl');
    // 4) etiquetas: solo si el aviso las trae (una lista vacía significa «sin etiquetas»; la ausencia, «no se informó»)
    const tagged = p.tags ? await this.reconcileTags(tx, ghlId, contactId, p.tags) : null;
    if (ev.eventType === 'message_in') return this.ingestMessage(tx, ev, p, contactId, outcome === 'contact_created', now, assign, tagged?.note ?? null);
    return { status: 'done', outcome: outcome ?? (changed || tagged?.changed ? 'contact_updated' : 'contact_unchanged'), contactId, note: tagged?.note ?? null };
  }

  /**
   * Un mensaje que el cliente escribió por GHL (M7.4): entra al Inbox por el canal «GoHighLevel» con el mismo reparto, SLA y bandeja que WhatsApp. El contacto ya viene resuelto (por el vínculo o por teléfono).
   * Idempotente por el identificador del mensaje en GHL (o, sin él, por el del propio aviso). El canal por el que llegó se guarda en el mensaje (`ghl_type`) para responder por el mismo.
   */
  private async ingestMessage(tx: TenantTx, ev: EventRow, p: { name: string | null; phone: string | null; message?: { id: string | null; text: string; type: string | null; sent_at: string | null } | null }, contactId: string, contactCreated: boolean, now: Date, assign: AssignmentContext | null, tagNote: string | null): Promise<Processed> {
    const m = p.message;
    if (!m || !m.text) return { status: 'skipped', note: 'El aviso no trae el texto del mensaje' };
    if (!assign) throw new Error('assign_context_missing'); // se reintenta con el contexto de reparto
    const [conn] = await tx.select({ status: ghlConnections.status }).from(ghlConnections).limit(1);
    if (!conn || conn.status === 'disconnected') return { status: 'skipped', note: 'GoHighLevel está desconectado: el mensaje no se registró' };
    const channelId = await this.channel.sync(tx, conn.status as 'active' | 'needs_reconnect');
    const parsed = m.sent_at ? new Date(m.sent_at) : now;
    // La hora que informa GHL no puede estar en el futuro (el cronómetro de respuesta corre desde el mensaje)
    const sentAt = Number.isNaN(parsed.getTime()) || parsed.getTime() > now.getTime() + 5 * 60_000 ? now : parsed;
    const normalized: NormalizedMessage = {
      externalId: m.id ? `ghl:${m.id}` : `ghl:evt:${ev.id}`,
      from: p.phone ?? '',
      fromRaw: ev.ghlContactId,
      profileName: p.name,
      kind: 'text',
      text: m.text,
      media: null,
      extra: m.type ? { ghl_type: m.type } : {},
      sentAt,
    };
    const r = await this.conversations.ingestInbound(tx, channelId, normalized, assign, { contactId, contactCreated, audit: 'ghl' });
    const notes = [r.duplicate ? 'Mensaje repetido: ya estaba registrado' : null, tagNote].filter((x): x is string => x !== null);
    return { status: 'done', outcome: 'message_received', contactId, note: notes.length > 0 ? notes.join('; ') : null };
  }

  /**
   * Refleja en el contacto las etiquetas que GHL dice que tiene (M7.3, anti-eco). Se compara con lo último que se supo de GHL (`ghl_contact_links.tags`): lo nuevo se agrega y lo que ya no está se quita,
   * SOLO entre las etiquetas personalizadas que existen aquí con ese nombre (sin distinguir mayúsculas; las del sistema nunca se tocan y las desconocidas se ignoran). Lo que se aplica se anuncia con
   * origen `ghl`, así que NO vuelve a salir hacia GHL. Una etiqueta con un cambio nuestro todavía por enviar no se toca (el aviso de GHL puede ser anterior a ese cambio). La primera vez que se
   * ve un contacto no hay con qué comparar: solo se agrega, nunca se quita.
   */
  private async reconcileTags(tx: TenantTx, ghlId: string, contactId: string, snapshot: readonly string[]): Promise<{ changed: boolean; note: string | null }> {
    const snap = [...new Set(snapshot.map((t) => t.toLowerCase()))];
    const [link] = await tx.select({ id: ghlContactLinks.id, tags: ghlContactLinks.tags }).from(ghlContactLinks).where(eq(ghlContactLinks.ghlContactId, ghlId)).limit(1);
    const prev = link?.tags ?? null;
    const custom = await tx.select({ id: tagsTable.id, name: tagsTable.name }).from(tagsTable).where(and(eq(tagsTable.isSystem, false), isNull(tagsTable.deletedAt)));
    const byName = new Map(custom.map((t) => [t.name.toLowerCase(), t]));
    const mine = new Set((await tx.select({ id: contactTags.tagId }).from(contactTags).where(eq(contactTags.contactId, contactId))).map((r) => r.id));
    const pending = new Set((await tx.select({ name: ghlOutbox.tagName }).from(ghlOutbox).where(and(eq(ghlOutbox.contactId, contactId), eq(ghlOutbox.status, 'pending')))).map((r) => r.name.toLowerCase()));

    const added = prev ? snap.filter((t) => !prev.includes(t)) : snap;
    const removed = prev ? prev.filter((t) => !snap.includes(t)) : [];
    let unmatched = 0;
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const name of added) {
      if (pending.has(name)) continue;
      const t = byName.get(name);
      if (!t) unmatched += 1;
      else if (!mine.has(t.id)) toAdd.push(t.id);
    }
    for (const name of removed) {
      if (pending.has(name)) continue;
      const t = byName.get(name);
      if (t && mine.has(t.id)) toRemove.push(t.id);
    }
    let changed = false;
    let counts: { added: string[]; removed: string[] } = { added: [], removed: [] };
    if (toAdd.length > 0 || toRemove.length > 0) {
      const nameOf = new Map(custom.map((t) => [t.id, t.name]));
      const before = [...mine].filter((id) => nameOf.has(id)).map((id) => nameOf.get(id)!).sort((a, b) => a.localeCompare(b));
      counts = await this.tagging.applyExternal(tx, contactId, { add: toAdd, remove: toRemove }, 'ghl');
      changed = counts.added.length > 0 || counts.removed.length > 0;
      if (changed) {
        const after = [...before.filter((n) => !counts.removed.includes(n)), ...counts.added].sort((a, b) => a.localeCompare(b));
        await writeAudit(tx, { entityType: 'contact', entityId: contactId, field: 'tags', oldValue: before, newValue: after, source: 'ghl' });
      }
    }
    if (link) await tx.update(ghlContactLinks).set({ tags: snap, tagsAt: new Date() }).where(eq(ghlContactLinks.id, link.id));
    const parts: string[] = [];
    if (counts.added.length > 0 || counts.removed.length > 0) parts.push(`Etiquetas: ${counts.added.length} agregada(s), ${counts.removed.length} quitada(s)`);
    if (unmatched > 0) parts.push(`${unmatched} etiqueta(s) de GoHighLevel sin equivalente aquí`);
    return { changed, note: parts.length > 0 ? parts.join('; ') : null };
  }

  /** Vacía el contenido de los avisos ya terminados con más de 30 días (minimización de datos personales): la fila queda como registro. */
  private async redactOld(tx: TenantTx, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - GHL_PAYLOAD_RETENTION_DAYS * 86_400_000);
    const old = await tx
      .select({ id: ghlEvents.id })
      .from(ghlEvents)
      .where(and(isNotNull(ghlEvents.payload), ne(ghlEvents.status, 'pending'), lte(ghlEvents.processedAt, cutoff)))
      .limit(REDACT_BATCH);
    if (old.length === 0) return;
    await tx
      .update(ghlEvents)
      .set({ payload: null, redactedAt: now })
      .where(inArray(ghlEvents.id, old.map((o) => o.id)));
  }

  // ------------------------------------------------------------------ panel

  /** Últimos avisos de la empresa, del más reciente al más antiguo (cursor). Solo lo que el administrador necesita para entender qué pasó: nunca teléfonos ni correos. */
  async list(q: { status?: GhlEventStatus | undefined; cursor?: string | undefined; limit?: number | undefined }): Promise<{ items: GhlEventView[]; next_cursor: string | null }> {
    const limit = q.limit ?? 30;
    const cur = this.decodeCursor(q.cursor);
    return this.db.withTenant(async (tx) => {
      const conds: SQL[] = [];
      if (q.status) conds.push(eq(ghlEvents.status, q.status));
      if (cur) conds.push(or(lt(ghlEvents.receivedAt, cur.at), and(eq(ghlEvents.receivedAt, cur.at), lt(ghlEvents.id, cur.id)))!);
      const rows = await tx
        .select({ id: ghlEvents.id, eventType: ghlEvents.eventType, ghlContactId: ghlEvents.ghlContactId, status: ghlEvents.status, outcome: ghlEvents.outcome, note: ghlEvents.note, contactId: ghlEvents.contactId, attempts: ghlEvents.attempts, lastError: ghlEvents.lastError, receivedAt: ghlEvents.receivedAt, processedAt: ghlEvents.processedAt })
        .from(ghlEvents)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(ghlEvents.receivedAt), desc(ghlEvents.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      // Nombres de los contactos en una consulta aparte (evita una unión que el compilador de tipos no resuelve bien)
      const names = new Map<string, string>();
      const ids = [...new Set(page.map((e) => e.contactId).filter((x): x is string => x !== null))];
      if (ids.length > 0) for (const c of await tx.select({ id: contacts.id, name: contacts.name }).from(contacts).where(inArray(contacts.id, ids))) names.set(c.id, c.name);
      const items = page.map((e): GhlEventView => ({
        id: e.id,
        type: e.eventType as GhlEventView['type'],
        ghl_contact_id: e.ghlContactId,
        status: e.status as GhlEventStatus,
        outcome: e.outcome as Outcome | null,
        note: e.note,
        contact: e.contactId && names.has(e.contactId) ? { id: e.contactId, name: names.get(e.contactId)! } : null,
        attempts: e.attempts,
        last_error: e.lastError,
        received_at: e.receivedAt.toISOString(),
        processed_at: e.processedAt?.toISOString() ?? null,
      }));
      const last = page.at(-1);
      return { items, next_cursor: rows.length > limit && last ? Buffer.from(`${last.receivedAt.toISOString()}|${last.id}`).toString('base64url') : null };
    });
  }

  private decodeCursor(raw: string | undefined): { at: Date; id: string } | null {
    if (!raw) return null;
    const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|');
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError([{ path: 'cursor', code: 'invalid', message: 'Cursor no válido' }]);
    return { at, id };
  }
}
