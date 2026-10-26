import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { appointmentReminders, appointments, channelAccounts, contacts, conversations, Database, messages, messageTemplates, type TenantTx } from '../../db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../errors';
import { AttributionService } from '../attribution';
import { writeAudit } from '../audit';
import { loadConversation, scopeOf, WINDOW_MS, type InboxAccess } from '../inbox';
import { OpportunitiesService } from '../opportunities';
import { OrgDirectoryService, OrgMembersService, pendingPerson } from '../organizations';
import { RealtimeService } from '../realtime';
import { renderedText, TemplatesService, type TemplateView } from '../templates';
import { MAX_AGENDA_DAYS, type CancelAppointmentDto, type CreateAppointmentDto, type ListAppointmentsQuery, type UpdateAppointmentDto } from './appointments.dto';

/** Tope de recordatorios por cita (ADR-13): 3; 5 si la fuente es WhatsApp QR, Messenger o Instagram. Hoy solo existe WhatsApp oficial, pero la regla ya queda aplicada. */
export const REMINDER_LIMIT = 3;
export const REMINDER_LIMIT_EXTENDED = 5;
const EXTENDED_SOURCES: ReadonlySet<string> = new Set(['whatsapp_qr', 'evolution', 'messenger', 'instagram']);
/** Margen antes de que cierre la ventana de 24 h en que todavía se confía en poder escribir con texto libre. */
export const WINDOW_MARGIN_MS = 60_000;
/** Un recordatorio que sale con más retraso que esto (p. ej. tras una caída del proceso) ya no se envía: «en 1 hora» llegaría desfasado. */
export const REMINDER_MAX_LATE_MS = 30 * 60_000;
export const REMINDER_BATCH = 50;
/** Las citas no se agendan en el pasado: se deja un minuto de tolerancia para el reloj del navegador. */
const PAST_TOLERANCE_MS = 60_000;

export interface ReminderView {
  id: string;
  offset_minutes: number;
  send_at: string;
  status: 'scheduled' | 'sent' | 'skipped' | 'failed' | 'cancelled';
  via: 'text' | 'template' | null;
  /** Por qué no salió (código). */
  reason: string | null;
  /** Estado de entrega del mensaje que se creó (`queued`, `sent`, `delivered`, `read`, `failed`); null si todavía no salió. */
  delivery: string | null;
}
export interface AppointmentView {
  id: string;
  contact: { id: string; name: string };
  conversation_id: string | null;
  owner: { id: string; name: string } | null;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  kind: string;
  notes: string | null;
  status: 'scheduled' | 'completed' | 'cancelled';
  cancel_reason: string | null;
  created_at: string;
  reminders: ReminderView[];
  reminder_offsets: number[];
  reminder_template: { id: string; name: string } | null;
  can: { edit: boolean; cancel: boolean; complete: boolean };
}
export interface AppointmentOptions {
  timezone: string;
  /** Tope de recordatorios para esta conversación. */
  max_reminders: number;
  window: { open: boolean; expires_at: string | null };
  /** Plantillas aprobadas de la conexión (para los recordatorios fuera de la ventana de 24 h). */
  templates: Array<Pick<TemplateView, 'id' | 'name' | 'language' | 'category' | 'body' | 'variables'>>;
  blocked: 'unassigned' | 'not_owner' | 'channel_off' | null;
}
export interface AppointmentList {
  items: AppointmentView[];
  /** Zona horaria de la empresa: en ella se muestra la agenda. */
  timezone: string;
}

/** Quién consulta: con `appointments.view_all` ve y gestiona las de toda la empresa; sin él, solo las suyas (como responsable). */
export interface AppointmentScope {
  readonly userId: string;
  readonly viewAll: boolean;
}

type Row = typeof appointments.$inferSelect;
const AUDIT = 'appointment';
type Created = { appointment: AppointmentView; created: boolean };

/** Fecha y hora de la cita como la lee el cliente, en la zona horaria de la empresa («martes 24 de octubre a las 15:30»). */
export function formatWhen(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('es-EC', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(at);
  const time = new Intl.DateTimeFormat('es-EC', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  return `${day} a las ${time}`;
}
export const reminderText = (kind: string, at: Date, timeZone: string): string => `Recordatorio: tienes una cita (${kind}) el ${formatWhen(at, timeZone)}. Si no puedes asistir, avísanos por aquí.`;

/**
 * Citas y recordatorios (M6.3, ADR-13/18/51; F13). La cita pertenece a quien atiende la conversación; con ella: etiqueta «Cita agendada», la oportunidad pasa a la etapa de cita
 * del pipeline (si la hay), el evento `Schedule` a Meta se encola por la CITA (aunque no haya etapa de cita) y los recordatorios quedan programados. El tope de recordatorios y la
 * regla de la ventana de 24 h se validan AQUÍ (la interfaz solo ayuda). Una cita no se borra: se cancela o se completa; cancelar o reprogramar cancela los recordatorios pendientes.
 * La empresa sale SIEMPRE de TenantContext; lo que la persona no ve responde 404.
 */
@Injectable()
export class AppointmentsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AttributionService) private readonly attribution: AttributionService,
    @Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
    @Inject(OrgDirectoryService) private readonly directory: OrgDirectoryService,
    @Inject(OrgMembersService) private readonly members: OrgMembersService,
    @Optional() @Inject(RealtimeService) private readonly realtime?: RealtimeService,
  ) {}

  // ------------------------------------------------------------------ opciones del formulario

  async options(access: InboxAccess, conversationId: string): Promise<AppointmentOptions> {
    const tz = (await this.directory.current()).timeZone;
    const base = await this.db.withTenant(async (tx) => {
      const scope = scopeOf(access);
      const { c, channel, contactSource } = await this.loadWithSource(tx, scope, conversationId);
      let blocked: AppointmentOptions['blocked'] = null;
      if (c.ownerId === null) blocked = 'unassigned';
      else if (c.ownerId !== scope.userId && !scope.viewAll) blocked = 'not_owner';
      else if (channel.state !== 'active') blocked = 'channel_off';
      const end = c.lastInboundAt ? c.lastInboundAt.getTime() + WINDOW_MS : null;
      const open = end !== null && end > Date.now();
      // GoHighLevel no tiene la ventana de 24 h de WhatsApp oficial (M7.4): los recordatorios salen como texto cuando toque
      const noWindow = contactSource.provider === 'ghl';
      return { channelId: c.channelAccountId, blocked, max: this.limitFor(contactSource.provider, contactSource.source), window: noWindow ? { open: true, expires_at: null } : { open, expires_at: end !== null ? new Date(end).toISOString() : null } };
    });
    const list = base.blocked === 'channel_off' ? { items: [] } : await this.templates.forChannel(base.channelId);
    return {
      timezone: tz,
      max_reminders: base.max,
      window: base.window,
      templates: list.items.filter((t) => t.sendable).map((t) => ({ id: t.id, name: t.name, language: t.language, category: t.category, body: t.body, variables: t.variables })),
      blocked: base.blocked,
    };
  }

  // ------------------------------------------------------------------ crear

  async create(access: InboxAccess, key: string, input: CreateAppointmentDto): Promise<Created> {
    const run = (): Promise<Created> => this.db.withTenant((tx) => this.createIn(tx, access, key, input));
    try {
      return await this.hydrate(await run());
    } catch (e) {
      // Dos peticiones con la misma llave a la vez: gana una y la otra devuelve lo mismo
      if (this.isKeyClash(e)) return this.hydrate(await this.db.withTenant((tx) => this.replay(tx, scopeOf(access), key, input)));
      throw e;
    }
  }

  private async replay(tx: TenantTx, scope: { userId: string; viewAll: boolean }, key: string, input: CreateAppointmentDto): Promise<Created> {
    const [found] = await tx.select().from(appointments).where(eq(appointments.idempotencyKey, key)).limit(1);
    if (!found) throw new ConflictError('IDEMPOTENCY_CONFLICT', 'Esa llave ya se usó en otra operación');
    this.assertSameRequest(found, scope.userId, input);
    return { appointment: (await this.viewMany(tx, [found.id], scope))[0]!, created: false };
  }

  private async createIn(tx: TenantTx, access: InboxAccess, key: string, input: CreateAppointmentDto): Promise<Created> {
    const scope = scopeOf(access);
    const [prior] = await tx.select().from(appointments).where(eq(appointments.idempotencyKey, key)).limit(1);
    if (prior) {
      this.assertSameRequest(prior, scope.userId, input);
      return { appointment: (await this.viewMany(tx, [prior.id], scope))[0]!, created: false };
    }

    const { c, channel, contactSource } = await this.loadWithSource(tx, scope, input.conversation_id, true);
    if (c.ownerId === null) throw new ConflictError('CONVERSATION_UNASSIGNED', 'La conversación aún no tiene asesor: asígnala o tómala antes de agendar');
    if (c.ownerId !== scope.userId && !scope.viewAll) throw new ForbiddenError('NOT_OWNER', 'Solo quien tiene asignada la conversación, o un administrador, puede agendar la cita');
    if (channel.state !== 'active') throw new ConflictError('CHANNEL_DISABLED', 'La conexión de WhatsApp de esta conversación está desactivada: no se podrían enviar los recordatorios');

    const now = new Date();
    const startsAt = new Date(input.starts_at);
    this.assertFuture(startsAt, now);
    const offsets = [...(input.reminders ?? [])].sort((a, b) => b - a);
    const tpl = await this.checkReminders(tx, { offsets, startsAt, now, channelId: c.channelAccountId, lastInboundAt: c.lastInboundAt, noWindow: contactSource.provider === 'ghl', limit: this.limitFor(contactSource.provider, contactSource.source), templateId: input.reminder_template_id ?? null, params: input.reminder_params ?? {} });

    const [a] = await tx
      .insert(appointments)
      .values({
        contactId: c.contactId,
        conversationId: c.id,
        ownerId: c.ownerId,
        startsAt,
        durationMinutes: input.duration_minutes ?? 30,
        kind: input.kind ?? 'Cita',
        notes: input.notes ?? null,
        reminderOffsets: offsets,
        reminderTemplateId: tpl ? input.reminder_template_id! : null,
        reminderParams: tpl ? (input.reminder_params ?? {}) : {},
        idempotencyKey: key,
        createdBy: scope.userId,
      })
      .returning();
    const appt = a!;
    await this.insertReminders(tx, appt.id, offsets, startsAt, now);
    await writeAudit(tx, { entityType: AUDIT, entityId: appt.id, newValue: { starts_at: startsAt.toISOString(), kind: appt.kind, owner_id: appt.ownerId, reminders: offsets }, source: 'manual' });

    // Efectos de agendar (F13): etiqueta + Schedule a Meta por la CITA, y la oportunidad pasa a la etapa de cita
    await this.attribution.onAppointmentCreated(tx, { contactId: appt.contactId, appointmentId: appt.id, startsAt }, now);
    const oppId = await this.opportunities.moveToAppointmentStage(tx, appt.contactId, scope.userId);
    if (oppId) await tx.update(appointments).set({ opportunityId: oppId }).where(eq(appointments.id, appt.id));
    this.realtime?.touchHere(c.id);
    return { appointment: (await this.viewMany(tx, [appt.id], scope))[0]!, created: true };
  }

  // ------------------------------------------------------------------ editar / reprogramar / cancelar / completar

  /** Cambia la cita. Si cambia la hora, los recordatorios o la plantilla, los pendientes se cancelan y se rehacen con la hora nueva. */
  async update(scope: AppointmentScope, id: string, input: UpdateAppointmentDto): Promise<AppointmentView> {
    return this.hydrate(
      await this.db.withTenant(async (tx) => {
        const cur = await this.lock(tx, scope, id);
        if (cur.status !== 'scheduled') throw new ConflictError('APPOINTMENT_CLOSED', 'La cita ya está cerrada: no se puede cambiar');
        const now = new Date();
        const startsAt = input.starts_at ? new Date(input.starts_at) : cur.startsAt;
        if (input.starts_at) this.assertFuture(startsAt, now);
        const offsets = input.reminders ? [...input.reminders].sort((a, b) => b - a) : cur.reminderOffsets;
        const rebuild = input.starts_at !== undefined || input.reminders !== undefined || input.reminder_template_id !== undefined || input.reminder_params !== undefined;
        const set: Partial<typeof appointments.$inferInsert> = {};
        const audits: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
        const change = (field: string, col: keyof typeof appointments.$inferInsert, before: unknown, next: unknown) => {
          if (next === undefined || JSON.stringify(next) === JSON.stringify(before)) return;
          (set as Record<string, unknown>)[col] = next;
          audits.push({ field, oldValue: before, newValue: next });
        };
        if (input.starts_at && startsAt.getTime() !== cur.startsAt.getTime()) {
          set.startsAt = startsAt;
          audits.push({ field: 'starts_at', oldValue: cur.startsAt.toISOString(), newValue: startsAt.toISOString() });
        }
        change('duration_minutes', 'durationMinutes', cur.durationMinutes, input.duration_minutes);
        change('kind', 'kind', cur.kind, input.kind);
        change('notes', 'notes', cur.notes, input.notes);
        if (rebuild) {
          const conv = cur.conversationId ? await this.conversationFacts(tx, cur.conversationId) : null;
          if (offsets.length > 0 && !conv) throw new ConflictError('APPOINTMENT_NO_CONVERSATION', 'La cita no tiene conversación: no se pueden programar recordatorios');
          const templateId = input.reminder_template_id !== undefined ? input.reminder_template_id : cur.reminderTemplateId;
          const params = input.reminder_params ?? cur.reminderParams;
          const useTemplate = conv && offsets.length > 0 ? await this.checkReminders(tx, { offsets, startsAt, now, channelId: conv.channelId, lastInboundAt: conv.lastInboundAt, noWindow: conv.provider === 'ghl', limit: this.limitFor(conv.provider, conv.source), templateId, params }) : false;
          change('reminders', 'reminderOffsets', cur.reminderOffsets, offsets);
          set.reminderTemplateId = useTemplate ? templateId : null;
          set.reminderParams = useTemplate ? params : {};
        }
        if (audits.length === 0 && !rebuild) return (await this.viewMany(tx, [id], scope))[0]!;
        await tx.update(appointments).set({ ...set, updatedAt: now }).where(eq(appointments.id, id));
        if (rebuild) {
          await this.cancelPending(tx, id, 'rescheduled', now);
          await this.insertReminders(tx, id, offsets, startsAt, now);
        }
        for (const a of audits) await writeAudit(tx, { entityType: AUDIT, entityId: id, field: a.field, oldValue: a.oldValue, newValue: a.newValue, source: 'manual' });
        if (cur.conversationId) this.realtime?.touchHere(cur.conversationId);
        return (await this.viewMany(tx, [id], scope))[0]!;
      }),
    );
  }

  async cancel(scope: AppointmentScope, id: string, input: CancelAppointmentDto): Promise<AppointmentView> {
    return this.hydrate(
      await this.db.withTenant(async (tx) => {
        const cur = await this.lock(tx, scope, id);
        if (cur.status === 'cancelled') throw new ConflictError('APPOINTMENT_ALREADY_CANCELLED', 'La cita ya estaba cancelada');
        if (cur.status === 'completed') throw new ConflictError('APPOINTMENT_CLOSED', 'La cita ya se completó: no se puede cancelar');
        const now = new Date();
        await tx.update(appointments).set({ status: 'cancelled', cancelledAt: now, cancelledBy: scope.userId, cancelReason: input.reason, updatedAt: now }).where(eq(appointments.id, id));
        await this.cancelPending(tx, id, 'appointment_cancelled', now);
        await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'status', oldValue: 'scheduled', newValue: 'cancelled', source: 'manual' });
        if (cur.conversationId) this.realtime?.touchHere(cur.conversationId);
        return (await this.viewMany(tx, [id], scope))[0]!;
      }),
    );
  }

  async complete(scope: AppointmentScope, id: string): Promise<AppointmentView> {
    return this.hydrate(
      await this.db.withTenant(async (tx) => {
        const cur = await this.lock(tx, scope, id);
        if (cur.status !== 'scheduled') throw new ConflictError('APPOINTMENT_CLOSED', 'La cita ya está cerrada');
        const now = new Date();
        await tx.update(appointments).set({ status: 'completed', completedAt: now, updatedAt: now }).where(eq(appointments.id, id));
        await this.cancelPending(tx, id, 'appointment_completed', now);
        await writeAudit(tx, { entityType: AUDIT, entityId: id, field: 'status', oldValue: 'scheduled', newValue: 'completed', source: 'manual' });
        return (await this.viewMany(tx, [id], scope))[0]!;
      }),
    );
  }

  // ------------------------------------------------------------------ consultas

  async list(scope: AppointmentScope, q: ListAppointmentsQuery): Promise<AppointmentList> {
    const timeZone = (await this.directory.current()).timeZone;
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 24 * 3_600_000);
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 31 * 24 * 3_600_000);
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_AGENDA_DAYS * 24 * 3_600_000) {
      throw new ValidationError([{ path: 'to', code: 'invalid_range', message: `El rango debe ser positivo y de máximo ${MAX_AGENDA_DAYS} días` }]);
    }
    return this.hydrate(
      await this.db.withTenant(async (tx) => {
        const conds: SQL[] = [gte(appointments.startsAt, from), lt(appointments.startsAt, to)];
        if (!scope.viewAll) conds.push(eq(appointments.ownerId, scope.userId));
        else if (q.owner_id) conds.push(eq(appointments.ownerId, q.owner_id));
        if (q.status) conds.push(eq(appointments.status, q.status));
        if (q.contact_id) conds.push(eq(appointments.contactId, q.contact_id));
        const rows = await tx.select({ id: appointments.id }).from(appointments).where(and(...conds)).orderBy(asc(appointments.startsAt), asc(appointments.id)).limit(500);
        return { items: await this.viewMany(tx, rows.map((r) => r.id), scope), timezone: timeZone };
      }),
    );
  }

  async get(scope: AppointmentScope, id: string): Promise<AppointmentView> {
    return this.hydrate(
      await this.db.withTenant(async (tx) => {
        await this.visible(tx, scope, id);
        return (await this.viewMany(tx, [id], scope))[0]!;
      }),
    );
  }

  // ------------------------------------------------------------------ envío de recordatorios (tarea periódica)

  /**
   * Una pasada de la tarea (bajo el TenantContext de la empresa): envía los recordatorios que ya les toca. Cada uno va en su `SAVEPOINT`. El recordatorio se crea como mensaje
   * AUTOMÁTICO en cola (no es una respuesta humana: no detiene el SLA ni mueve la conversación); lo envía el despachador de siempre y su estado de entrega es el del mensaje.
   * Dentro de la ventana de 24 h va como texto; fuera, con la plantilla de la cita; sin plantilla, queda `skipped` con el motivo. Devuelve cuántos resolvió.
   */
  async runDue(now: Date, timeZone: string, batch = REMINDER_BATCH): Promise<number> {
    return this.db.withTenant(async (tx) => {
      const due = await tx
        .select({ r: appointmentReminders, a: appointments })
        .from(appointmentReminders)
        .innerJoin(appointments, and(eq(appointments.organizationId, appointmentReminders.organizationId), eq(appointments.id, appointmentReminders.appointmentId)))
        .where(and(eq(appointmentReminders.status, 'scheduled'), sql`${appointmentReminders.sendAt} <= ${now.toISOString()}::timestamptz`))
        .orderBy(asc(appointmentReminders.sendAt), asc(appointmentReminders.id))
        .limit(batch)
        .for('update', { skipLocked: true, of: appointmentReminders });
      let n = 0;
      for (const { r, a } of due) {
        await tx.execute(sql`SAVEPOINT reminder_one`);
        try {
          const outcome = await this.deliver(tx, r, a, now, timeZone);
          await tx.update(appointmentReminders).set({ status: outcome.status, via: outcome.via ?? null, messageId: outcome.messageId ?? null, reason: outcome.reason ?? null, resolvedAt: now }).where(eq(appointmentReminders.id, r.id));
          await tx.execute(sql`RELEASE SAVEPOINT reminder_one`);
          if (a.conversationId) this.realtime?.touchHere(a.conversationId);
          n += 1;
        } catch {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT reminder_one`);
          // Un fallo inesperado no se reintenta sin fin: queda `failed` y la persona lo ve
          await tx.update(appointmentReminders).set({ status: 'failed', reason: 'error', resolvedAt: now }).where(eq(appointmentReminders.id, r.id));
          n += 1;
        }
      }
      return n;
    });
  }

  private async deliver(
    tx: TenantTx,
    r: typeof appointmentReminders.$inferSelect,
    a: Row,
    now: Date,
    tz: string,
  ): Promise<{ status: 'sent' | 'skipped'; via?: 'text' | 'template'; messageId?: string; reason?: string }> {
    if (a.status !== 'scheduled') return { status: 'skipped', reason: 'appointment_closed' };
    if (a.startsAt.getTime() <= now.getTime()) return { status: 'skipped', reason: 'expired' };
    if (now.getTime() - r.sendAt.getTime() > REMINDER_MAX_LATE_MS) return { status: 'skipped', reason: 'late' };
    if (!a.conversationId) return { status: 'skipped', reason: 'no_conversation' };
    const conv = await this.conversationFacts(tx, a.conversationId);
    if (!conv || conv.channelState !== 'active') return { status: 'skipped', reason: 'channel_off' };

    const windowOpen = conv.provider === 'ghl' || (conv.lastInboundAt !== null && conv.lastInboundAt.getTime() + WINDOW_MS - WINDOW_MARGIN_MS > now.getTime());
    let kind: 'text' | 'template';
    let body: string;
    let meta: Record<string, unknown> = {};
    if (windowOpen) {
      kind = 'text';
      body = reminderText(a.kind, a.startsAt, tz);
    } else if (a.reminderTemplateId) {
      try {
        const row = await this.templates.getSendable(tx, conv.channelId, a.reminderTemplateId);
        const p = this.templates.prepare(row, a.reminderParams);
        kind = 'template';
        body = renderedText(p.rendered);
        meta = { template: { id: row.id, name: row.name, language: row.language, category: row.category, buttons: p.rendered.buttons, send: p.send } };
      } catch {
        return { status: 'skipped', reason: 'template_unavailable' };
      }
    } else {
      return { status: 'skipped', reason: 'window_closed' };
    }
    const [m] = await tx
      .insert(messages)
      .values({ conversationId: a.conversationId, channelAccountId: conv.channelId, direction: 'out', senderType: 'automation', kind, body, meta, status: 'queued', sentAt: now, attempts: 0, nextAttemptAt: now })
      .returning({ id: messages.id });
    return { status: 'sent', via: kind, messageId: m!.id };
  }

  // ------------------------------------------------------------------ internos

  private assertFuture(startsAt: Date, now: Date): void {
    if (startsAt.getTime() < now.getTime() - PAST_TOLERANCE_MS) throw new ValidationError([{ path: 'starts_at', code: 'in_past', message: 'La cita debe ser en el futuro' }]);
  }

  private limitFor(provider: string | null, source: string | null): number {
    return (provider && EXTENDED_SOURCES.has(provider)) || (source && EXTENDED_SOURCES.has(source)) ? REMINDER_LIMIT_EXTENDED : REMINDER_LIMIT;
  }

  /**
   * Valida los recordatorios: tope por fuente, que cada uno caiga en el futuro y, si alguno cae fuera de la ventana de 24 h de WhatsApp, que haya una plantilla aprobada y válida
   * (ADR-13/51). Devuelve true si se guardará la plantilla.
   */
  private async checkReminders(tx: TenantTx, p: { offsets: number[]; startsAt: Date; now: Date; channelId: string; lastInboundAt: Date | null; noWindow?: boolean; limit: number; templateId: string | null; params: Record<string, string> }): Promise<boolean> {
    if (p.offsets.length > p.limit) throw new ValidationError([{ path: 'reminders', code: 'too_many', message: `Máximo ${p.limit} recordatorios por cita en este canal` }]);
    for (const o of p.offsets) {
      if (p.startsAt.getTime() - o * 60_000 <= p.now.getTime()) throw new ValidationError([{ path: 'reminders', code: 'in_past', message: `El recordatorio de ${o} minutos antes ya habría pasado: quítalo o agenda la cita más adelante` }]);
    }
    const windowEnd = p.noWindow ? Number.POSITIVE_INFINITY : p.lastInboundAt ? p.lastInboundAt.getTime() + WINDOW_MS - WINDOW_MARGIN_MS : Number.NEGATIVE_INFINITY;
    const needsTemplate = p.offsets.some((o) => p.startsAt.getTime() - o * 60_000 > windowEnd);
    if (!p.templateId) {
      if (needsTemplate) throw new ValidationError([{ path: 'reminder_template_id', code: 'required', message: 'Algún recordatorio saldría después de que se cierre la ventana de 24 h de WhatsApp: elige una plantilla aprobada para enviarlo' }]);
      return false;
    }
    const row = await this.templates.getSendable(tx, p.channelId, p.templateId);
    this.templates.prepare(row, p.params);
    return true;
  }

  private async insertReminders(tx: TenantTx, appointmentId: string, offsets: readonly number[], startsAt: Date, now: Date): Promise<void> {
    const rows = offsets.filter((o) => startsAt.getTime() - o * 60_000 > now.getTime()).map((o) => ({ appointmentId, offsetMinutes: o, sendAt: new Date(startsAt.getTime() - o * 60_000) }));
    if (rows.length > 0) await tx.insert(appointmentReminders).values(rows);
  }

  private async cancelPending(tx: TenantTx, appointmentId: string, reason: string, now: Date): Promise<void> {
    await tx.update(appointmentReminders).set({ status: 'cancelled', reason, resolvedAt: now }).where(and(eq(appointmentReminders.appointmentId, appointmentId), eq(appointmentReminders.status, 'scheduled')));
  }

  private async conversationFacts(tx: TenantTx, conversationId: string): Promise<{ channelId: string; channelState: 'active' | 'disabled' | 'removed'; provider: string; source: string | null; lastInboundAt: Date | null } | null> {
    const [row] = await tx
      .select({ channelId: conversations.channelAccountId, lastInboundAt: conversations.lastInboundAt, status: channelAccounts.status, deletedAt: channelAccounts.deletedAt, provider: channelAccounts.provider, source: contacts.source })
      .from(conversations)
      .innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, conversations.organizationId), eq(channelAccounts.id, conversations.channelAccountId)))
      .innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId)))
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!row) return null;
    const channelState = row.deletedAt !== null ? 'removed' : row.status === 'active' ? 'active' : 'disabled';
    return { channelId: row.channelId, channelState, provider: row.provider, source: row.source, lastInboundAt: row.lastInboundAt };
  }

  /** La conversación visible para esta persona, con el canal y la fuente del contacto (para el tope de recordatorios). */
  private async loadWithSource(tx: TenantTx, scope: ReturnType<typeof scopeOf>, conversationId: string, lock = false) {
    const loaded = await loadConversation(tx, scope, conversationId, lock);
    const [row] = await tx.select({ provider: channelAccounts.provider, source: contacts.source }).from(conversations).innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, conversations.organizationId), eq(channelAccounts.id, conversations.channelAccountId))).innerJoin(contacts, and(eq(contacts.organizationId, conversations.organizationId), eq(contacts.id, conversations.contactId))).where(eq(conversations.id, conversationId)).limit(1);
    return { ...loaded, contactSource: { provider: row?.provider ?? null, source: row?.source ?? null } };
  }

  private assertSameRequest(found: Row, userId: string, input: CreateAppointmentDto): void {
    if (found.createdBy !== userId) throw new ConflictError('IDEMPOTENCY_CONFLICT', 'Esa llave ya se usó en otra operación');
    if (found.conversationId !== input.conversation_id || found.startsAt.getTime() !== new Date(input.starts_at).getTime()) throw new ConflictError('IDEMPOTENCY_MISMATCH', 'Esa llave ya se usó con otros datos');
  }

  private isKeyClash(e: unknown): boolean {
    const cause = (e as { cause?: { code?: string; constraint?: string } } | null)?.cause;
    return cause?.code === '23505' && cause.constraint === 'appointments_org_key_uq';
  }

  private async visible(tx: TenantTx, scope: AppointmentScope, id: string): Promise<Row> {
    const [a] = await tx.select().from(appointments).where(and(eq(appointments.id, id), scope.viewAll ? undefined : eq(appointments.ownerId, scope.userId))).limit(1);
    if (!a) throw new NotFoundError();
    return a;
  }

  private async lock(tx: TenantTx, scope: AppointmentScope, id: string): Promise<Row> {
    const [a] = await tx.select().from(appointments).where(and(eq(appointments.id, id), scope.viewAll ? undefined : eq(appointments.ownerId, scope.userId))).for('update').limit(1);
    if (!a) throw new NotFoundError();
    return a;
  }

  private async viewMany(tx: TenantTx, ids: readonly string[], scope: AppointmentScope): Promise<AppointmentView[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ a: appointments, contactName: contacts.name })
      .from(appointments)
      .innerJoin(contacts, and(eq(contacts.organizationId, appointments.organizationId), eq(contacts.id, appointments.contactId)))
      .where(inArray(appointments.id, [...ids]));
    const reminders = await tx
      .select({ id: appointmentReminders.id, appointmentId: appointmentReminders.appointmentId, offsetMinutes: appointmentReminders.offsetMinutes, sendAt: appointmentReminders.sendAt, status: appointmentReminders.status, via: appointmentReminders.via, reason: appointmentReminders.reason, messageId: appointmentReminders.messageId })
      .from(appointmentReminders)
      .where(inArray(appointmentReminders.appointmentId, [...ids]))
      .orderBy(asc(appointmentReminders.sendAt), asc(appointmentReminders.offsetMinutes));
    // Estado de entrega: el del mensaje que se creó (consulta aparte; evita una unión que el compilador no resuelve bien)
    const messageIds = reminders.flatMap((x) => (x.messageId ? [x.messageId] : []));
    const delivery = new Map<string, string>();
    if (messageIds.length > 0) for (const m of await tx.select({ id: messages.id, status: messages.status }).from(messages).where(inArray(messages.id, messageIds))) delivery.set(m.id, m.status);
    const byAppt = new Map<string, ReminderView[]>();
    for (const x of reminders) {
      const list = byAppt.get(x.appointmentId) ?? [];
      list.push({ id: x.id, offset_minutes: x.offsetMinutes, send_at: x.sendAt.toISOString(), status: x.status as ReminderView['status'], via: x.via as ReminderView['via'], reason: x.reason, delivery: x.messageId ? (delivery.get(x.messageId) ?? null) : null });
      byAppt.set(x.appointmentId, list);
    }
    const templateIds = [...new Set(rows.flatMap((r) => (r.a.reminderTemplateId ? [r.a.reminderTemplateId] : [])))];
    const names = new Map<string, string>();
    if (templateIds.length > 0) {
      for (const t of await tx.select({ id: messageTemplates.id, name: messageTemplates.name }).from(messageTemplates).where(inArray(messageTemplates.id, templateIds))) names.set(t.id, t.name);
    }
    const order = new Map(ids.map((id, i) => [id, i]));
    return rows
      .map((r): AppointmentView => {
        const a = r.a;
        const open = a.status === 'scheduled';
        const mine = scope.viewAll || a.ownerId === scope.userId;
        return {
          id: a.id,
          contact: { id: a.contactId, name: r.contactName },
          conversation_id: a.conversationId,
          owner: pendingPerson(a.ownerId),
          starts_at: a.startsAt.toISOString(),
          ends_at: new Date(a.startsAt.getTime() + a.durationMinutes * 60_000).toISOString(),
          duration_minutes: a.durationMinutes,
          kind: a.kind,
          notes: a.notes,
          status: a.status as AppointmentView['status'],
          cancel_reason: a.cancelReason,
          created_at: a.createdAt.toISOString(),
          reminders: byAppt.get(a.id) ?? [],
          reminder_offsets: a.reminderOffsets,
          reminder_template: a.reminderTemplateId ? { id: a.reminderTemplateId, name: names.get(a.reminderTemplateId) ?? '' } : null,
          can: { edit: open && mine, cancel: open && mine, complete: open && mine },
        };
      })
      .sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
  }

  private hydrate<T>(value: T): Promise<T> {
    return this.members.hydrate(value);
  }
}
