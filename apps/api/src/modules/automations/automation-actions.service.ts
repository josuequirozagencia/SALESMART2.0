import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { automations, automationSettings, contactPhones, contacts, conversations, tags, tasks, type TenantTx } from '../../db';
import { AppError } from '../../errors';
import { writeAudit } from '../audit';
import { AgentRuntimeService } from '../ai';
import { ContactsService } from '../contacts';
import { CustomValuesService } from '../custom-fields';
import { currentAutomationOrigin } from '../events';
import { OpportunitiesService } from '../opportunities';
import type { OrgDirectory } from '../organizations';
import { OutreachService } from '../outreach';
import { AssignmentService } from '../queues';
import { ContactTaggingService } from '../tags';
import { hostAllowed, parseDestination } from './address-guard';
import { AutomationEnqueueService } from './automation-enqueue.service';
import { httpVariablesUsed, renderHttpBody, renderParam, renderText, type ActionDef } from './automation-model';
import { OUTBOUND_HTTP, OUTBOUND_MAX_BODY_BYTES, OutboundError, type OutboundHttp } from './outbound-http';

/** Lo que una acción necesita saber de la ejecución. */
export interface ActionContext {
  readonly contactId: string;
  readonly now: Date;
  readonly dir: OrgDirectory;
  /** Posición de la acción en la ejecución (para la llave de idempotencia de una llamada HTTP). */
  readonly step: number;
}

export interface StepOutcome {
  readonly outcome: 'done' | 'skipped' | 'failed';
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
    @Inject(AutomationEnqueueService) private readonly enqueue: AutomationEnqueueService,
    @Inject(AgentRuntimeService) private readonly agents: AgentRuntimeService,
    @Inject(OUTBOUND_HTTP) private readonly outbound: OutboundHttp,
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
        case 'run_rule':
          return await this.runRule(tx, a.automation_id, ctx);
        case 'start_agent':
          return await this.startAgent(tx, ctx);
        case 'http_request':
          return await this.httpRequest(tx, a, ctx);
        case 'wait':
          throw new ActionFailed('La espera la maneja el motor, no una acción'); // no debería llegar: el motor corta aquí la ejecución
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

  /** Pide ejecutar otra automatización sobre este contacto: pasa por las mismas defensas que un hecho (profundidad, ciclo, tope por hora) y por sus condiciones, y corre en su propia ejecución. */
  private async runRule(tx: TenantTx, ruleId: string, ctx: ActionContext): Promise<StepOutcome> {
    const [target] = await tx.select().from(automations).where(and(eq(automations.id, ruleId), isNull(automations.deletedAt))).limit(1);
    if (!target) throw new ActionFailed('La automatización que debía ejecutar ya no existe');
    if (target.status !== 'active') throw new ActionSkipped(`«${target.name}» no está activa`);
    const origin = currentAutomationOrigin();
    const r = await this.enqueue.callRule(tx, target, ctx.contactId, origin, `call:${origin?.runId ?? 'sin-origen'}:${target.id}`);
    if (r === 'queued') return done(`Se ejecutará «${target.name}»`);
    if (r === 'no_match') throw new ActionSkipped(`El contacto no cumple las condiciones de «${target.name}»`);
    if (r === 'duplicate') throw new ActionSkipped(`Ya se había pedido ejecutar «${target.name}» desde esta ejecución`);
    // Se DEVUELVE (no se lanza): lanzarlo deshace el SAVEPOINT y con él la ejecución «omitida» que dejó el encolador, que es justo lo que se quiere poder ver en el historial
    return { outcome: 'skipped', detail: `«${target.name}» se omitió (ciclo, demasiadas reglas encadenadas o tope por hora): mira su historial` };
  }

  /** Activa al agente de IA de la conexión en la conversación abierta del contacto: desde ahora contesta lo que escriba el cliente (lo anterior no se contesta). */
  private async startAgent(tx: TenantTx, ctx: ActionContext): Promise<StepOutcome> {
    const t = await this.agents.startTarget(tx, ctx.contactId);
    if (!t.ok) throw new ActionSkipped({ no_conversation: 'No hay una conversación abierta con el contacto', no_agent: 'La conexión de la conversación no tiene un agente de IA activo', already_active: 'El agente de IA ya está activo en la conversación' }[t.reason]);
    await this.agents.resume(tx, t.conversationId, 'automation');
    return done('Agente de IA activado en la conversación');
  }

  /**
   * Llama a otro sistema (M9.5b, ADR-54): solo a un dominio de la lista de permitidos de la empresa, por https, sin seguir redirecciones, a una dirección pública validada, con 10 s de límite.
   * El cuerpo lleva solo las variables del contacto que el administrador puso, escapadas como JSON. Un fallo DEVUELVE «failed» (no lanza): lanzarlo deshace el SAVEPOINT y con él la
   * auditoría de lo que ya salió. En la auditoría y el historial queda el dominio, el método y el código de respuesta —nunca la dirección completa, el cuerpo ni la respuesta—.
   */
  private async httpRequest(tx: TenantTx, a: Extract<ActionDef, { type: 'http_request' }>, ctx: ActionContext): Promise<StepOutcome> {
    const dest = parseDestination(a.url);
    if (!dest.ok) throw new ActionFailed(dest.message);
    const [settings] = await tx.select({ hosts: automationSettings.httpAllowedHosts }).from(automationSettings).limit(1);
    if (!hostAllowed(dest.host, settings?.hosts ?? [])) throw new ActionFailed(`El dominio ${dest.host} no está en la lista de permitidos de la empresa`);
    const [c] = await tx.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts).where(and(eq(contacts.id, ctx.contactId), isNull(contacts.deletedAt))).limit(1);
    if (!c) throw new ActionFailed('El contacto ya no existe');
    const [p] = await tx.select({ e164: contactPhones.e164 }).from(contactPhones).where(and(eq(contactPhones.contactId, ctx.contactId), isNull(contactPhones.deletedAt))).orderBy(desc(contactPhones.isPrimary), contactPhones.createdAt).limit(1);
    const template = a.method === 'POST' && a.body !== undefined && a.body.trim() !== '' ? a.body : null;
    const body = template === null ? null : renderHttpBody(template, { nombre: c.name, primer_nombre: c.name.trim().split(/\s+/)[0] ?? '', correo: c.email ?? '', telefono: p?.e164 ?? '', id: c.id });
    if (body !== null && Buffer.byteLength(body, 'utf8') > OUTBOUND_MAX_BODY_BYTES) throw new ActionFailed(`El cuerpo pasa de ${OUTBOUND_MAX_BODY_BYTES / 1024} KB una vez armado`);
    const origin = currentAutomationOrigin();
    let status: number;
    try {
      status = (await this.outbound.send({ url: dest.url, method: a.method, body, idempotencyKey: `${origin?.runId ?? 'sin-origen'}:${ctx.step}` })).status;
    } catch (e) {
      if (e instanceof OutboundError) throw new ActionFailed(`Llamada a ${dest.host}: ${e.message}`);
      throw e;
    }
    await writeAudit(tx, { entityType: 'contact', entityId: ctx.contactId, field: 'http_request', oldValue: null, newValue: { host: dest.host, method: a.method, status, variables: template === null ? [] : httpVariablesUsed(template) }, source: 'automation' });
    if (status >= 200 && status < 300) return done(`Llamada a ${dest.host}: respondió ${status}`);
    if (status >= 300 && status < 400) return { outcome: 'failed', detail: `${dest.host} respondió ${status}: las redirecciones no se siguen` };
    return { outcome: 'failed', detail: `${dest.host} respondió ${status}` };
  }
}
