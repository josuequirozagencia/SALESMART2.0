import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { contacts, Database, ghlConnections, ghlContactLinks, ghlOutbox, type TenantTx } from '../../db';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import type { AppLogger } from '../../logger';
import { APP_LOGGER } from '../../tokens';
import { ContactsService } from '../contacts';
import { TagChangeBus, type TagChange, type TagChangeListener, type TagDeleted, type TagDeletedListener } from '../tags';
import { GhlConnectionService } from './ghl-connection.service';
import { GHL_PROVIDER, GhlError, type GhlCredentials, type GhlProvider } from './ghl.ports';

export const GHL_OUTBOX_BATCH = 10;
export const GHL_OUTBOX_MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 10 * 60_000;

type OutboxRow = typeof ghlOutbox.$inferSelect;
export type GhlOutboxStatus = 'pending' | 'done' | 'skipped' | 'failed';

export interface GhlOutboxView {
  id: string;
  op: 'tag_add' | 'tag_remove' | 'tag_delete';
  tag: string;
  tag_kind: 'system' | 'custom';
  status: GhlOutboxStatus;
  contact: { id: string; name: string } | null;
  note: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  processed_at: string | null;
  /** ¿Se puede reintentar desde el panel? Solo los fallidos. */
  can_retry: boolean;
}

/** Etiqueta del error SIN su mensaje (podría llevar un teléfono o un correo): solo la clase y el código de la base de datos. */
function errorLabel(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : typeof (e as { code?: unknown } | null)?.code === 'string' ? ((e as { code: string }).code) : null;
  const name = e instanceof Error ? e.name : 'Error';
  return (code ? `${name}:${code}` : name).slice(0, 100);
}

type Delivery = { status: 'done'; note?: string } | { status: 'skipped'; note: string };

/**
 * Salida de etiquetas hacia GoHighLevel (M7.3, ADR-52). Las etiquetas que se ponen o se quitan aquí se anotan en `ghl_outbox` DENTRO de la transacción del cambio (el `TagChangeBus` avisa);
 * la tarea las envía a GHL en orden por contacto, con reintentos. Un cambio que VINO de GHL no entra (anti-eco). Todo corre dentro del TenantContext de la empresa que pone quien llama.
 *  - Solo se anota si la empresa tiene una conexión no desconectada; con la conexión en `needs_reconnect` lo anotado ESPERA (no se pierde) y sale al reconectar.
 *  - Un contacto que aún no está en GHL se busca o crea por teléfono (o correo) al AGREGAR una etiqueta; al QUITAR una a quien no está en GHL no se hace nada.
 *  - Un rechazo de credenciales deja la conexión en `needs_reconnect` y detiene la pasada sin gastar intentos; un fallo pasajero reintenta con espera creciente; uno definitivo marca el aviso `failed`.
 */
@Injectable()
export class GhlOutboxService implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TagChangeBus) private readonly bus: TagChangeBus,
    @Inject(GhlConnectionService) private readonly connection: GhlConnectionService,
    @Inject(GHL_PROVIDER) private readonly provider: GhlProvider,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe(this.onTagChange);
    this.bus.subscribeDeleted(this.onTagDeleted);
  }

  /** Oyente del bus: anota el cambio para GHL, dentro de la transacción del cambio de etiqueta. */
  private readonly onTagChange: TagChangeListener = async (tx: TenantTx, change: TagChange) => {
    if (change.origin === 'ghl') return; // anti-eco: lo que vino de GHL no se le devuelve
    const [c] = await tx.select({ status: ghlConnections.status }).from(ghlConnections).limit(1);
    if (!c || c.status === 'disconnected') return;
    await tx.insert(ghlOutbox).values({ contactId: change.contactId, op: change.op === 'add' ? 'tag_add' : 'tag_remove', tagName: change.tagName, tagKind: change.tagKind, createdAt: new Date() }); // hora con milisegundos: el cursor del panel la compara exacta
  };

  /**
   * Oyente del bus: una etiqueta personalizada se BORRÓ aquí, así que también se elimina en GHL (decisión del responsable de producto, ADR-52). Los cambios pendientes de ESA etiqueta ya no
   * tienen sentido (se omiten, para no volver a crearla allá) y las altas posteriores con el mismo nombre esperan a que termine el borrado (ver `runDue`).
   */
  private readonly onTagDeleted: TagDeletedListener = async (tx: TenantTx, ev: TagDeleted) => {
    if (ev.origin === 'ghl') return;
    const [c] = await tx.select({ status: ghlConnections.status }).from(ghlConnections).limit(1);
    if (!c || c.status === 'disconnected') return;
    await tx
      .update(ghlOutbox)
      .set({ status: 'skipped', note: 'La etiqueta se eliminó antes de enviarse', processedAt: new Date() })
      .where(and(eq(ghlOutbox.status, 'pending'), sql`${ghlOutbox.op} <> 'tag_delete'`, sql`lower(${ghlOutbox.tagName}) = lower(${ev.tagName})`));
    await tx.insert(ghlOutbox).values({ contactId: null, op: 'tag_delete', tagName: ev.tagName, tagKind: 'custom', createdAt: new Date() });
  };

  // ------------------------------------------------------------------ envío

  /** Envía lo pendiente cuya hora ya llegó. Devuelve cuántos tomó. Sin conexión activa no hace nada (lo anotado espera). */
  async runDue(now: Date, batch = GHL_OUTBOX_BATCH): Promise<number> {
    return this.db.withTenant(async (tx) => {
      const creds = await this.connection.credentials(tx);
      if (!creds) return 0;
      // Solo el más antiguo pendiente de cada contacto: mantiene el orden (un reintento en espera frena a los que vienen después de ese contacto)
      const due = await tx
        .select()
        .from(ghlOutbox)
        .where(
          and(
            eq(ghlOutbox.status, 'pending'),
            lte(ghlOutbox.nextAttemptAt, now),
            sql`NOT EXISTS (SELECT 1 FROM ghl_outbox p WHERE p.organization_id = "ghl_outbox"."organization_id" AND p.contact_id = "ghl_outbox"."contact_id" AND p.status = 'pending' AND (p.created_at, p.id) < ("ghl_outbox"."created_at", "ghl_outbox"."id"))`,
            // Mientras un borrado de etiqueta esté pendiente, las altas posteriores con ese mismo nombre esperan (si no, el borrado se llevaría la etiqueta nueva)
            sql`NOT EXISTS (SELECT 1 FROM ghl_outbox d WHERE d.organization_id = "ghl_outbox"."organization_id" AND d.op = 'tag_delete' AND d.status = 'pending' AND lower(d.tag_name) = lower("ghl_outbox"."tag_name") AND (d.created_at, d.id) < ("ghl_outbox"."created_at", "ghl_outbox"."id"))`,
          ),
        )
        .orderBy(asc(ghlOutbox.createdAt), asc(ghlOutbox.id))
        .limit(batch)
        .for('update', { skipLocked: true });
      let taken = 0;
      for (const row of due) {
        taken += 1;
        if ((await this.processOne(tx, row, creds, now)) === 'halt') break;
      }
      return taken;
    });
  }

  private async processOne(tx: TenantTx, row: OutboxRow, creds: GhlCredentials & { id: string }, now: Date): Promise<'ok' | 'halt'> {
    const attempts = row.attempts + 1;
    // SAVEPOINT: si algo falla se revierte solo lo de este aviso (por ejemplo, un vínculo a medio crear)
    await tx.execute(sql`SAVEPOINT ghl_outbox`);
    let failure: unknown = null;
    let result: Delivery | null = null;
    try {
      result = await this.deliver(tx, row, { locationId: creds.locationId, accessToken: creds.accessToken }, now); // al proveedor solo van el token y la Location
      await tx.execute(sql`RELEASE SAVEPOINT ghl_outbox`);
    } catch (e) {
      failure = e;
      await tx.execute(sql`ROLLBACK TO SAVEPOINT ghl_outbox`);
    }
    if (failure === null && result) {
      if (result.status === 'done') await tx.update(ghlOutbox).set({ status: 'done', attempts, processedAt: now, lastError: null, note: result.note ?? null }).where(eq(ghlOutbox.id, row.id));
      else await tx.update(ghlOutbox).set({ status: 'skipped', attempts, processedAt: now, note: result.note.slice(0, 200), lastError: null }).where(eq(ghlOutbox.id, row.id));
      await this.connection.noteCallResult(tx, creds.id, { ok: true }, now);
      return 'ok';
    }
    if (failure instanceof GhlError && failure.credentials) {
      // El token ya no sirve: la conexión pide reconexión y esto queda esperando, sin gastar intentos
      await this.connection.noteCallResult(tx, creds.id, { ok: false, message: failure.message, credentials: true }, now);
      return 'halt';
    }
    if (failure instanceof GhlError && !failure.retryable) {
      await tx.update(ghlOutbox).set({ status: 'failed', attempts, processedAt: now, lastError: failure.message.slice(0, 300), note: null }).where(eq(ghlOutbox.id, row.id));
      return 'ok';
    }
    const label = failure instanceof GhlError ? failure.message.slice(0, 300) : errorLabel(failure);
    this.log.warn({ outbox_id: row.id, attempts, err: failure instanceof GhlError ? 'GhlError' : label }, 'envío a GoHighLevel no se pudo completar');
    if (attempts >= GHL_OUTBOX_MAX_ATTEMPTS) {
      await tx.update(ghlOutbox).set({ status: 'failed', attempts, processedAt: now, lastError: label }).where(eq(ghlOutbox.id, row.id));
    } else {
      const wait = Math.min(2 ** attempts * 7_500, MAX_BACKOFF_MS);
      await tx.update(ghlOutbox).set({ attempts, lastError: label, nextAttemptAt: new Date(now.getTime() + wait) }).where(eq(ghlOutbox.id, row.id));
    }
    return 'ok';
  }

  private async deliver(tx: TenantTx, row: OutboxRow, creds: GhlCredentials, now: Date): Promise<Delivery> {
    if (row.op === 'tag_delete') return this.deliverTagDelete(tx, row, creds, now);
    const [contact] = await tx.select({ id: contacts.id, name: contacts.name, email: contacts.email, deletedAt: contacts.deletedAt }).from(contacts).where(eq(contacts.id, row.contactId!)).limit(1);
    if (!contact || contact.deletedAt) return { status: 'skipped', note: 'El contacto ya no existe' };
    let [link] = await tx.select().from(ghlContactLinks).where(eq(ghlContactLinks.contactId, row.contactId!)).limit(1);
    if (!link) {
      // Quitar una etiqueta a quien no está en GHL no tiene nada que hacer; agregarla sí exige que exista allá
      if (row.op === 'tag_remove') return { status: 'skipped', note: 'El contacto no está en GoHighLevel: no hay etiqueta que quitar' };
      const who = await this.contacts.channelIdentity(tx, row.contactId!);
      const phone = who?.primaryPhone ?? null;
      if (!phone && !contact.email) return { status: 'skipped', note: 'El contacto no tiene teléfono ni correo: no se puede buscar ni crear en GoHighLevel' };
      const placeholder = phone !== null && contact.name === phone;
      const found = await this.provider.upsertContact(creds, { name: placeholder ? null : contact.name, phone, email: contact.email });
      const [other] = await tx.select({ contactId: ghlContactLinks.contactId }).from(ghlContactLinks).where(eq(ghlContactLinks.ghlContactId, found.id)).limit(1);
      if (other && other.contactId !== row.contactId!) return { status: 'skipped', note: 'Ese contacto de GoHighLevel ya está vinculado a otro contacto de Sales Smart' };
      [link] = await tx.insert(ghlContactLinks).values({ ghlContactId: found.id, contactId: row.contactId! }).returning();
    }
    if (row.op === 'tag_add') await this.provider.addTags(creds, link!.ghlContactId, [row.tagName]);
    else await this.provider.removeTags(creds, link!.ghlContactId, [row.tagName]);
    // Anti-eco: GHL ya tiene el cambio, así que cuando avise de él no habrá nada nuevo que aplicar aquí
    if (link!.tags) {
      const key = row.tagName.toLowerCase();
      const next = row.op === 'tag_add' ? [...new Set([...link!.tags, key])] : link!.tags.filter((t) => t !== key);
      await tx.update(ghlContactLinks).set({ tags: next, tagsAt: now }).where(eq(ghlContactLinks.id, link!.id));
    }
    return { status: 'done' };
  }

  /** Elimina la etiqueta en GHL y la quita del estado de sincronización de todos los contactos (así los avisos que GHL dispare por ello no traen nada que aplicar aquí). */
  private async deliverTagDelete(tx: TenantTx, row: OutboxRow, creds: GhlCredentials, now: Date): Promise<Delivery> {
    const res = await this.provider.deleteTag(creds, row.tagName);
    await tx.execute(sql`UPDATE ghl_contact_links SET tags = (SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements_text(tags) AS v WHERE lower(v) <> lower(${row.tagName})), tags_at = ${now} WHERE tags IS NOT NULL`);
    return res.deleted ? { status: 'done' } : { status: 'done', note: 'GoHighLevel no tenía esa etiqueta' };
  }

  // ------------------------------------------------------------------ panel

  /** Cambios de etiqueta enviados (o por enviar) a GHL, del más reciente al más antiguo (cursor). */
  async list(q: { status?: GhlOutboxStatus | undefined; cursor?: string | undefined; limit?: number | undefined }): Promise<{ items: GhlOutboxView[]; next_cursor: string | null; counts: Record<string, number> }> {
    const limit = q.limit ?? 30;
    const cur = this.decodeCursor(q.cursor);
    return this.db.withTenant(async (tx) => {
      const conds: SQL[] = [];
      if (q.status) conds.push(eq(ghlOutbox.status, q.status));
      if (cur) conds.push(or(lt(ghlOutbox.createdAt, cur.at), and(eq(ghlOutbox.createdAt, cur.at), lt(ghlOutbox.id, cur.id)))!);
      const rows = await tx
        .select()
        .from(ghlOutbox)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(ghlOutbox.createdAt), desc(ghlOutbox.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const names = new Map<string, string>();
      const ids = [...new Set(page.map((e) => e.contactId).filter((x): x is string => x !== null))];
      if (ids.length > 0) for (const c of await tx.select({ id: contacts.id, name: contacts.name }).from(contacts).where(inArray(contacts.id, ids))) names.set(c.id, c.name);
      const counts: Record<string, number> = {};
      for (const r of await tx.select({ status: ghlOutbox.status, n: sql<number>`count(*)::int` }).from(ghlOutbox).groupBy(ghlOutbox.status)) counts[r.status] = r.n;
      const items = page.map((e): GhlOutboxView => ({
        id: e.id,
        op: e.op as GhlOutboxView['op'],
        tag: e.tagName,
        tag_kind: e.tagKind as GhlOutboxView['tag_kind'],
        status: e.status as GhlOutboxStatus,
        contact: e.contactId && names.has(e.contactId) ? { id: e.contactId, name: names.get(e.contactId)! } : null,
        note: e.note,
        attempts: e.attempts,
        last_error: e.lastError,
        created_at: e.createdAt.toISOString(),
        processed_at: e.processedAt?.toISOString() ?? null,
        can_retry: e.status === 'failed',
      }));
      const last = page.at(-1);
      return { items, next_cursor: rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null, counts };
    });
  }

  /** Vuelve a poner en cola un cambio fallido. */
  async retry(id: string): Promise<{ id: string; status: 'pending' }> {
    return this.db.withTenant(async (tx) => {
      const [cur] = await tx.select({ status: ghlOutbox.status }).from(ghlOutbox).where(eq(ghlOutbox.id, id)).for('update').limit(1);
      if (!cur) throw new NotFoundError();
      if (cur.status !== 'failed') throw new ConflictError('GHL_OUTBOX_NOT_FAILED', 'Solo se pueden reintentar los cambios que fallaron');
      await tx.update(ghlOutbox).set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null, processedAt: null }).where(eq(ghlOutbox.id, id));
      return { id, status: 'pending' as const };
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
