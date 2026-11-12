import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { AppConfig } from '../../config';
import { appointmentCalendarEvents, appointments, calendarConnections, contacts, Database, type TenantTx } from '../../db';
import type { AppLogger } from '../../logger';
import { APP_CONFIG, APP_LOGGER } from '../../tokens';
import { writeAudit } from '../audit';
import { OrgDirectoryService, OrgMembersService } from '../organizations';
import { CalendarConnectionService } from './calendar-connection.service';
import { CalendarError, type CalendarEventInput } from './calendar.ports';
import { CALENDAR_PROVIDER, type CalendarProvider } from './calendar.ports';

/** Cuántas citas se reconcilian por pasada y empresa. */
export const SYNC_BATCH = 20;
/** Una tarea que murió a medias deja la cita «tomada»: pasado este tiempo se retoma. */
export const SYNC_LEASE_MS = 3 * 60_000;
/** Intentos pasajeros antes de dar la cita por fallida (se puede reintentar a mano). */
export const SYNC_MAX_ATTEMPTS = 8;
/** Espera creciente entre intentos (ms). */
export const SYNC_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 2_400_000, 3_600_000] as const;

/**
 * El id del evento en Google, DETERMINISTA a partir de la cita (Google solo admite a-v y 0-9, de 5 a 1024 caracteres): reintentar la creación no duplica. Si el evento se borró a propósito
 * (cancelar la cita o apagar «Crear evento en Google Calendar»), la siguiente creación usa una `generation` nueva: Google no deja reutilizar el id de un evento borrado.
 */
export const eventIdOf = (appointmentId: string, generation = 0): string => appointmentId.replace(/-/g, '').toLowerCase() + (generation > 0 ? `g${generation}` : '');

export interface SyncStats {
  pending: number;
  failed: number;
  gone: number;
  synced: number;
  last_synced_at: string | null;
}

type Link = typeof appointmentCalendarEvents.$inferSelect;
interface Loaded {
  link: Link;
  appt: { id: string; status: string; calendarSync: boolean; startsAt: Date; durationMinutes: number; kind: string; ownerId: string; conversationId: string | null; contactName: string } | null;
}

/**
 * Sincronización de las citas con Google Calendar (v11 Pista G, 67b, ADR-67). NO es una cola de operaciones: cuando una cita cambia (`markDirty`, dentro de SU transacción) se anota que hay que
 * reconciliarla, y la tarea compara la cita de ahora con el evento de Google —crea, actualiza o borra— y da por hecho solo lo que leyó si la cita no volvió a cambiar mientras tanto (`seq`).
 * Es solo de salida (Sales Smart → Google). A Google va únicamente el título «<tipo> · <contacto> · <asesor>», las horas en la zona de la empresa y un enlace a la conversación: nunca teléfono,
 * correo ni invitados. Una cita cancelada borra su evento; una completada lo deja como está. Si la persona borra el evento en Google se respeta (`gone`) y no se vuelve a crear.
 * Token rechazado ⇒ la conexión pasa a «requiere reconectar» SIN gastar intentos; al reconectar, lo pendiente sale solo.
 */
@Injectable()
export class CalendarSyncService {
  private readonly baseUrl: string | null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) cfg: AppConfig,
    @Inject(CALENDAR_PROVIDER) private readonly provider: CalendarProvider,
    @Inject(CalendarConnectionService) private readonly connection: CalendarConnectionService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {
    this.baseUrl = cfg.frontend.baseUrl ?? null;
  }

  // ------------------------------------------------------------------ anotar que una cita cambió

  /**
   * La cita cambió: hay que reconciliarla con Google. Se llama DENTRO de la transacción que la cambia. Sin calendario conectado no hace nada (las citas de antes de conectar no se envían).
   * Un evento que la persona borró en Google (`gone`) sigue así.
   */
  async markDirty(tx: TenantTx, appointmentId: string, enabled = true): Promise<void> {
    const [conn] = await tx.select({ status: calendarConnections.status }).from(calendarConnections).limit(1);
    if (!conn || conn.status === 'disconnected') return;
    const now = new Date();
    if (!enabled) {
      // La persona apagó «Crear evento en Google Calendar»: solo hay algo que hacer si ya existía un evento (se borra); si nunca hubo vínculo, no se crea uno
      await tx
        .update(appointmentCalendarEvents)
        .set({ syncState: sql`CASE WHEN ${appointmentCalendarEvents.syncState} = 'gone' THEN 'gone' ELSE 'pending' END`, seq: sql`${appointmentCalendarEvents.seq} + 1`, attempts: 0, nextAttemptAt: now, processingStartedAt: null, lastError: null, updatedAt: now })
        .where(eq(appointmentCalendarEvents.appointmentId, appointmentId));
      return;
    }
    await tx
      .insert(appointmentCalendarEvents)
      .values({ appointmentId, syncState: 'pending', nextAttemptAt: now })
      .onConflictDoUpdate({
        target: [appointmentCalendarEvents.organizationId, appointmentCalendarEvents.appointmentId],
        set: {
          syncState: sql`CASE WHEN ${appointmentCalendarEvents.syncState} = 'gone' THEN 'gone' ELSE 'pending' END`,
          seq: sql`${appointmentCalendarEvents.seq} + 1`,
          attempts: 0,
          nextAttemptAt: now,
          processingStartedAt: null,
          lastError: null,
          updatedAt: now,
        },
      });
  }

  // ------------------------------------------------------------------ la tarea

  /** Una pasada para la empresa del contexto: reconcilia las citas que les toca. Devuelve cuántas tocó. */
  async runDue(now: Date): Promise<number> {
    const due = await this.db.withTenant(async (tx) => {
      const [r] = await tx
        .select({ n: count() })
        .from(appointmentCalendarEvents)
        .where(and(eq(appointmentCalendarEvents.syncState, 'pending'), lte(appointmentCalendarEvents.nextAttemptAt, now), or(isNull(appointmentCalendarEvents.processingStartedAt), lt(appointmentCalendarEvents.processingStartedAt, new Date(now.getTime() - SYNC_LEASE_MS)))));
      return r?.n ?? 0;
    });
    if (due === 0) return 0;
    const auth = await this.connection.authorize(); // solo si hay algo que enviar: no se le pide un acceso a Google a una empresa sin trabajo
    if (!auth.ok) return 0; // sin calendario listo no se gastan intentos: sale solo al conectar o reconectar
    const ids = await this.db.withTenant(async (tx) => {
      const rows = await tx
        .select({ id: appointmentCalendarEvents.id })
        .from(appointmentCalendarEvents)
        .where(and(eq(appointmentCalendarEvents.syncState, 'pending'), lte(appointmentCalendarEvents.nextAttemptAt, now), or(isNull(appointmentCalendarEvents.processingStartedAt), lt(appointmentCalendarEvents.processingStartedAt, new Date(now.getTime() - SYNC_LEASE_MS)))))
        .orderBy(asc(appointmentCalendarEvents.nextAttemptAt))
        .limit(SYNC_BATCH)
        .for('update', { skipLocked: true });
      if (rows.length > 0) await tx.update(appointmentCalendarEvents).set({ processingStartedAt: now }).where(inArray(appointmentCalendarEvents.id, rows.map((r) => r.id)));
      return rows.map((r) => r.id);
    });
    const dir = await this.directory.current(); // identidad: fuera de la transacción de negocio
    let touched = 0;
    for (const id of ids) {
      try {
        if (await this.processOne(id, now, auth, dir.timeZone)) touched += 1;
      } catch (e) {
        this.log.error({ err: e instanceof Error ? e.name : 'desconocido', link_id: id }, 'falló la sincronización de una cita con Google Calendar');
        await this.release(id, now, 'Error inesperado al sincronizar');
      }
    }
    return touched;
  }

  /** Reconcilia UNA cita en tres tiempos: (A) leer, (B) hablar con Google fuera de la transacción, (C) anotar el resultado si la cita no volvió a cambiar. */
  private async processOne(id: string, now: Date, auth: { accessToken: string; calendarId: string }, timeZone: string): Promise<boolean> {
    const loaded = await this.load(id);
    if (!loaded) return false;
    const { link, appt } = loaded;
    const calendarId = link.calendarId ?? auth.calendarId;
    try {
      let result: { eventId: string | null; etag: string | null; state: 'synced' | 'gone'; calendarId: string | null; note: string | null; generation: number };
      if (!appt || appt.status === 'cancelled' || !appt.calendarSync) {
        // Borrar es idempotente: también cubre el caso de una tarea que murió justo después de crear el evento
        await this.provider.deleteEvent({ accessToken: auth.accessToken, calendarId, eventId: link.eventId ?? eventIdOf(link.appointmentId, link.generation) });
        result = { eventId: null, etag: null, state: 'synced', calendarId: link.calendarId, note: null, generation: link.generation + 1 };
      } else if (appt.status === 'completed') {
        result = { eventId: link.eventId, etag: link.etag, state: 'synced', calendarId: link.calendarId, note: null, generation: link.generation }; // una cita realizada se deja en el calendario como historia
      } else {
        const owner = (await this.members.labels([appt.ownerId])).get(appt.ownerId)?.name ?? 'Asesor';
        const event = this.eventOf(appt, owner, timeZone, link.appointmentId, link.generation);
        try {
          if (link.eventId) {
            const ref = await this.provider.updateEvent({ accessToken: auth.accessToken, calendarId, eventId: link.eventId, event });
            result = { eventId: ref.eventId, etag: ref.etag, state: 'synced', calendarId, note: null, generation: link.generation };
          } else {
            try {
              const ref = await this.provider.createEvent({ accessToken: auth.accessToken, calendarId, event });
              result = { eventId: ref.eventId, etag: ref.etag, state: 'synced', calendarId, note: null, generation: link.generation };
            } catch (e) {
              if (!(e instanceof CalendarError) || e.kind !== 'exists') throw e;
              const ref = await this.provider.updateEvent({ accessToken: auth.accessToken, calendarId, eventId: event.id, event }); // ya estaba (una pasada anterior murió antes de anotarlo)
              result = { eventId: ref.eventId, etag: ref.etag, state: 'synced', calendarId, note: null, generation: link.generation };
            }
          }
        } catch (e) {
          if (e instanceof CalendarError && e.kind === 'gone') result = { eventId: link.eventId, etag: link.etag, state: 'gone', calendarId, note: 'El evento se borró en Google: no se vuelve a crear', generation: link.generation };
          else throw e;
        }
      }
      return await this.finish(link, now, result);
    } catch (e) {
      return await this.fail(link, now, e);
    }
  }

  private eventOf(a: NonNullable<Loaded['appt']>, owner: string, timeZone: string, appointmentId: string, generation: number): CalendarEventInput {
    const link = this.baseUrl && a.conversationId ? `\n${this.baseUrl}/inbox/${a.conversationId}` : '';
    return {
      id: eventIdOf(appointmentId, generation),
      summary: `${a.kind} · ${a.contactName} · ${owner}`.slice(0, 200),
      description: `Cita agendada en Sales Smart.${link}`,
      startsAt: a.startsAt,
      endsAt: new Date(a.startsAt.getTime() + a.durationMinutes * 60_000),
      timeZone,
    };
  }

  private async load(id: string): Promise<Loaded | null> {
    return this.db.withTenant(async (tx) => {
      const [link] = await tx.select().from(appointmentCalendarEvents).where(eq(appointmentCalendarEvents.id, id)).limit(1);
      if (!link) return null;
      const [a] = await tx
        .select({ id: appointments.id, status: appointments.status, calendarSync: appointments.calendarSync, startsAt: appointments.startsAt, durationMinutes: appointments.durationMinutes, kind: appointments.kind, ownerId: appointments.ownerId, conversationId: appointments.conversationId, contactName: contacts.name })
        .from(appointments)
        .innerJoin(contacts, and(eq(contacts.organizationId, appointments.organizationId), eq(contacts.id, appointments.contactId)))
        .where(eq(appointments.id, link.appointmentId))
        .limit(1);
      return { link, appt: a ? { ...a, contactName: a.contactName || 'Contacto' } : null };
    });
  }

  /** Anota el resultado SOLO si la cita no cambió mientras se hablaba con Google; si cambió, queda pendiente para otra pasada. */
  private async finish(link: Link, now: Date, r: { eventId: string | null; etag: string | null; state: 'synced' | 'gone'; calendarId: string | null; note: string | null; generation: number }): Promise<boolean> {
    return this.db.withTenant(async (tx) => {
      const [cur] = await tx.update(appointmentCalendarEvents).set({ syncState: r.state, eventId: r.eventId, etag: r.etag, calendarId: r.calendarId, generation: r.generation, attempts: 0, lastError: r.note, syncedAt: now, processingStartedAt: null, updatedAt: now }).where(and(eq(appointmentCalendarEvents.id, link.id), eq(appointmentCalendarEvents.seq, link.seq))).returning({ id: appointmentCalendarEvents.id });
      if (!cur) {
        // La cita volvió a cambiar: lo que se envió ya quedó viejo; se vuelve a reconciliar enseguida (el evento ya existe, así que ahora solo se actualiza)
        await tx.update(appointmentCalendarEvents).set({ eventId: r.eventId, etag: r.etag, calendarId: r.calendarId, generation: r.generation, processingStartedAt: null, nextAttemptAt: now, updatedAt: now }).where(eq(appointmentCalendarEvents.id, link.id));
        return false;
      }
      if (r.state === 'gone') await writeAudit(tx, { entityType: 'calendar_event', entityId: link.appointmentId, field: 'sync_state', newValue: 'gone', source: 'automation' });
      return true;
    });
  }

  private async fail(link: Link, now: Date, e: unknown): Promise<boolean> {
    if (e instanceof CalendarError && e.credentials) {
      await this.connection.markConnectionNeedsReconnect(e.message); // el permiso ya no sirve: no es culpa de la cita ni gasta intentos
      await this.release(link.id, now, e.message, false);
      return false;
    }
    const retryable = !(e instanceof CalendarError) || e.retryable;
    const message = e instanceof CalendarError ? e.message : 'Error inesperado al sincronizar';
    const attempts = link.attempts + 1;
    await this.db.withTenant(async (tx) => {
      const exhausted = !retryable || attempts >= SYNC_MAX_ATTEMPTS;
      await tx
        .update(appointmentCalendarEvents)
        .set({ syncState: exhausted ? 'failed' : 'pending', attempts, nextAttemptAt: new Date(now.getTime() + (SYNC_BACKOFF_MS[Math.min(attempts - 1, SYNC_BACKOFF_MS.length - 1)] ?? 3_600_000)), lastError: message.slice(0, 300), processingStartedAt: null, updatedAt: now })
        .where(eq(appointmentCalendarEvents.id, link.id));
      if (exhausted) await writeAudit(tx, { entityType: 'calendar_event', entityId: link.appointmentId, field: 'sync_state', newValue: 'failed', source: 'automation' });
    });
    return false;
  }

  private async release(id: string, now: Date, message: string, spend = true): Promise<void> {
    await this.db
      .withTenant((tx) =>
        tx
          .update(appointmentCalendarEvents)
          .set({ processingStartedAt: null, lastError: message.slice(0, 300), nextAttemptAt: new Date(now.getTime() + 60_000), ...(spend ? { attempts: sql`${appointmentCalendarEvents.attempts} + 1` } : {}), updatedAt: now })
          .where(eq(appointmentCalendarEvents.id, id)),
      )
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------ para la pantalla

  async stats(): Promise<SyncStats> {
    return this.db.withTenant(async (tx) => {
      const rows = await tx.select({ state: appointmentCalendarEvents.syncState, n: count() }).from(appointmentCalendarEvents).groupBy(appointmentCalendarEvents.syncState);
      const by = new Map(rows.map((r) => [r.state, r.n]));
      const [last] = await tx.select({ at: appointmentCalendarEvents.syncedAt }).from(appointmentCalendarEvents).orderBy(desc(appointmentCalendarEvents.syncedAt)).limit(1);
      return { pending: by.get('pending') ?? 0, failed: by.get('failed') ?? 0, gone: by.get('gone') ?? 0, synced: by.get('synced') ?? 0, last_synced_at: last?.at?.toISOString() ?? null };
    });
  }

  /** Vuelve a poner en cola las citas que fallaron (por ejemplo, tras arreglar la API en Google Cloud). */
  async retryFailed(): Promise<{ requeued: number }> {
    return this.db.withTenant(async (tx) => {
      const now = new Date();
      const rows = await tx.update(appointmentCalendarEvents).set({ syncState: 'pending', attempts: 0, nextAttemptAt: now, processingStartedAt: null, lastError: null, seq: sql`${appointmentCalendarEvents.seq} + 1`, updatedAt: now }).where(eq(appointmentCalendarEvents.syncState, 'failed')).returning({ id: appointmentCalendarEvents.id });
      if (rows.length > 0) await writeAudit(tx, { entityType: 'calendar_event', entityId: rows[0]!.id, field: 'sync_retry', newValue: { requeued: rows.length }, source: 'manual' });
      return { requeued: rows.length };
    });
  }
}
