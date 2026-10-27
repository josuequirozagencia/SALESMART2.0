import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { contactPhones, contacts, conversations, tags, tasks, type TenantTx } from '../../db';
import { AppError } from '../../errors';
import { writeAudit } from '../audit';
import { ContactsService } from '../contacts';
import { CustomValuesService } from '../custom-fields';
import { OpportunitiesService } from '../opportunities';
import type { OrgDirectory } from '../organizations';
import { OutreachService } from '../outreach';
import { AssignmentService } from '../queues';
import { ContactTaggingService } from '../tags';
import { renderParam, renderText, type ActionDef } from './automation-model';

/** Lo que una acción necesita saber de la ejecución. */
export interface ActionContext {
  readonly contactId: string;
  readonly now: Date;
  readonly dir: OrgDirectory;
}

export interface StepOutcome {
  readonly outcome: 'done' | 'skipped';
  /** Una frase corta, sin datos personales (se guarda en el historial de la ejecución). */
  readonly detail: string;
}

/** Lo que la regla pidió no se puede hacer AHORA y no es un error (ya estaba hecho, no hay a quién, la ventana se cerró…). */
export class ActionSkipped extends Error {}
/** Lo que la regla pidió ya no es posible (algo que nombra dejó de existir): se registra el paso como fallido y la regla sigue con los demás. */
export class ActionFailed extends Error {}

const done = (detail: string): StepOutcome => ({ outcome: 'done', detail });

/**
 * Las acciones que una automatización puede hacer (M9.3, ADR-54; F20). Cada una corre DENTRO de la transacción de la ejecución (en su `SAVEPOINT`) y reutiliza el servicio dueño de esa parte del
 * negocio —ninguna escribe tablas ajenas—, así que respeta sus reglas y su auditoría (origen `automation`). Todo lo que el editor guardó se vuelve a comprobar aquí: la regla puede haber
 * sobrevivido a que la etapa, la cola o la persona que nombra cambiaran o desaparecieran.
 */
@Injectable()
export class AutomationActionsService {
  constructor(
    @Inject(ContactsService) private readonly contactsSvc: ContactsService,
    @Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService,
    @Inject(AssignmentService) private readonly assignment: AssignmentService,
    @Inject(ContactTaggingService) private readonly tagging: ContactTaggingService,
    @Inject(CustomValuesService) private readonly custom: CustomValuesService,
    @Inject(OutreachService) private readonly outreach: OutreachService,
  ) {}

  async execute(tx: TenantTx, a: ActionDef, ctx: ActionContext): Promise<StepOutcome> {
    try {
      switch (a.type) {
        case 'assign_user':
          return await this.assignUser(tx, a.user_id, ctx);
        case 'assign_queue':
          return await this.assignQueue(tx, a.queue_id, ctx);
        case 'move_stage':
          return await this.moveStage(tx, a.stage_id, ctx);
        case 'set_field':
          return await this.setField(tx, a.field, a.value, ctx);
        case 'add_tag':
        case 'remove_tag':
          return await this.tag(tx, a.type, a.tag_id, ctx);
        case 'create_task':
          return await this.createTask(tx, a, ctx);
        case 'send_text':
          return await this.sendText(tx, a.text, ctx);
        case 'send_template':
          return await this.sendTemplate(tx, a, ctx);
      }
    } catch (e) {
      // Un error de negocio previsto (validación, conflicto, no encontrado) no es una falla del sistema: el paso falla con su mensaje y la regla sigue
      if (e instanceof AppError) throw new ActionFailed(e.message);
      throw e;
    }
  }

  private async assignUser(tx: TenantTx, userId: string, ctx: ActionContext): Promise<StepOutcome> {
    if (!ctx.dir.assignable.has(userId)) throw new ActionFailed('Esa persona ya no puede recibir trabajo en la empresa');
    const before = await this.contactsSvc.ownerOf(tx, ctx.contactId);
    const changed = await this.contactsSvc.reassignOwner(tx, ctx.contactId, userId, 'automation');
    const moved = await this.opportunities.reassignOpenOwner(tx, ctx.contactId, before, userId, 'automation');
    if (!changed && moved === 0) throw new ActionSkipped('El contacto ya era de esa persona');
    return done(moved > 0 ? `Responsable cambiado (y ${moved} ${moved === 1 ? 'oportunidad' : 'oportunidades'})` : 'Responsable cambiado');
  }

  private async assignQueue(tx: TenantTx, queueId: string, ctx: ActionContext): Promise<StepOutcome> {
    const [conv] = await tx
      .select({ id: conversations.id, queueId: conversations.queueId })
      .from(conversations)
      .where(and(eq(conversations.contactId, ctx.contactId), eq(conversations.status, 'unassigned')))
      .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
      .limit(1)
      .for('update');
    if (!conv) throw new ActionSkipped('No hay una conversación sin asignar');
    if (conv.queueId !== queueId) await tx.update(conversations).set({ queueId, updatedAt: ctx.now }).where(eq(conversations.id, conv.id));
    const r = await this.assignment.assignConversation(tx, conv.id, { now: ctx.now, timeZone: ctx.dir.timeZone, assignable: ctx.dir.assignable });
    return done(r.assigned ? 'Conversación asignada con el reparto de la cola' : 'Quedó en la cola, sin asesor disponible por ahora');
  }

  private async moveStage(tx: TenantTx, stageId: string, ctx: ActionContext): Promise<StepOutcome> {
    const r = await this.opportunities.moveByRule(tx, ctx.contactId, stageId);
    if (r === 'invalid_stage') throw new ActionFailed('La etapa ya no existe, está oculta o no es una etapa abierta');
    if (r === 'no_opportunity') throw new ActionSkipped('El contacto no tiene una oportunidad abierta en ese pipeline');
    if (r === 'same') throw new ActionSkipped('La oportunidad ya estaba en esa etapa');
    return done('Oportunidad movida de etapa');
  }

  private async setField(tx: TenantTx, field: string, value: string, ctx: ActionContext): Promise<StepOutcome> {
    const changes = await this.custom.apply(tx, 'contact', ctx.contactId, { [field]: value }, { creating: false });
    if (changes.length === 0) throw new ActionSkipped('El campo ya tenía ese valor');
    for (const c of changes) await writeAudit(tx, { entityType: 'contact', entityId: ctx.contactId, field: `custom.${c.key}`, oldValue: c.oldValue, newValue: c.newValue, source: 'automation' });
    return done(`Campo «${field}» actualizado`);
  }

  private async tag(tx: TenantTx, kind: 'add_tag' | 'remove_tag', tagId: string, ctx: ActionContext): Promise<StepOutcome> {
    const [t] = await tx.select().from(tags).where(and(eq(tags.id, tagId), isNull(tags.deletedAt))).limit(1);
    if (!t || t.isSystem) throw new ActionFailed('La etiqueta ya no existe o es del sistema');
    const r = await this.tagging.applyExternal(tx, ctx.contactId, kind === 'add_tag' ? { add: [tagId], remove: [] } : { add: [], remove: [tagId] }, 'local');
    const changed = kind === 'add_tag' ? r.added : r.removed;
    if (changed.length === 0) throw new ActionSkipped(kind === 'add_tag' ? 'El contacto ya tenía la etiqueta' : 'El contacto no tenía la etiqueta');
    await writeAudit(tx, { entityType: 'contact', entityId: ctx.contactId, field: 'tags', oldValue: null, newValue: kind === 'add_tag' ? { added: changed } : { removed: changed }, source: 'automation' });
    return done(kind === 'add_tag' ? `Etiqueta «${t.name}» puesta` : `Etiqueta «${t.name}» quitada`);
  }

  private async createTask(tx: TenantTx, a: Extract<ActionDef, { type: 'create_task' }>, ctx: ActionContext): Promise<StepOutcome> {
    const [c] = await tx.select({ name: contacts.name, ownerId: contacts.ownerId }).from(contacts).where(and(eq(contacts.id, ctx.contactId), isNull(contacts.deletedAt))).limit(1);
    if (!c) throw new ActionFailed('El contacto ya no existe');
    const assignee = a.assignee === 'owner' ? c.ownerId : a.assignee;
    if (!assignee) throw new ActionSkipped('El contacto no tiene responsable a quien asignarle la tarea');
    if (!ctx.dir.assignable.has(assignee)) throw new ActionFailed('Esa persona ya no puede recibir trabajo en la empresa');
    const title = renderText(a.title, c).slice(0, 200) || 'Tarea automática';
    const dueAt = a.due_in_hours === undefined ? null : new Date(ctx.now.getTime() + a.due_in_hours * 3_600_000);
    const [t] = await tx.insert(tasks).values({ title, dueAt, assigneeId: assignee, contactId: ctx.contactId, createdBy: assignee }).returning({ id: tasks.id });
    await writeAudit(tx, { entityType: 'task', entityId: t!.id, newValue: { title, due_at: dueAt?.toISOString() ?? null, assignee_id: assignee, contact_id: ctx.contactId }, source: 'automation' });
    return done('Tarea creada');
  }

  private async sendText(tx: TenantTx, text: string, ctx: ActionContext): Promise<StepOutcome> {
    const [c] = await tx.select({ name: contacts.name }).from(contacts).where(and(eq(contacts.id, ctx.contactId), isNull(contacts.deletedAt))).limit(1);
    if (!c) throw new ActionFailed('El contacto ya no existe');
    const r = await this.outreach.sendText(tx, { contactId: ctx.contactId, text: renderText(text, c), now: ctx.now });
    if (r.sent) return done('Mensaje en cola');
    throw new ActionSkipped(
      { revoked: 'El contacto revocó su consentimiento', no_conversation: 'No hay una conversación abierta con el contacto', window_closed: 'Pasaron más de 24 h desde su último mensaje: solo se puede enviar una plantilla', channel_unavailable: 'La conexión no está activa' }[r.reason],
    );
  }

  private async sendTemplate(tx: TenantTx, a: Extract<ActionDef, { type: 'send_template' }>, ctx: ActionContext): Promise<StepOutcome> {
    const [c] = await tx.select({ name: contacts.name, ownerId: contacts.ownerId }).from(contacts).where(and(eq(contacts.id, ctx.contactId), isNull(contacts.deletedAt))).limit(1);
    if (!c) throw new ActionFailed('El contacto ya no existe');
    const [p] = await tx.select({ e164: contactPhones.e164 }).from(contactPhones).where(and(eq(contactPhones.contactId, ctx.contactId), isNull(contactPhones.deletedAt))).orderBy(desc(contactPhones.isPrimary), contactPhones.createdAt).limit(1);
    if (!p) throw new ActionSkipped('El contacto no tiene teléfono');
    const params = Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, renderParam(v, c)]));
    const r = await this.outreach.sendTemplate(tx, { contactId: ctx.contactId, phone: p.e164, channelId: a.channel_id, templateId: a.template_id, params, queueId: null, ownerId: c.ownerId, now: ctx.now });
    if (r.sent) return done('Plantilla en cola');
    throw new ActionSkipped({ revoked: 'El contacto revocó su consentimiento', channel_unavailable: 'La conexión no está activa', template_unavailable: 'La plantilla ya no está disponible o sus valores no son válidos' }[r.reason]);
  }
}
