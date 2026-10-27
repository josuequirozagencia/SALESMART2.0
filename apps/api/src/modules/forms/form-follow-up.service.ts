import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { forms, tasks, type TenantTx } from '../../db';
import { writeAudit } from '../audit';
import { OutreachService } from '../outreach';

type FormRow = typeof forms.$inferSelect;
export type FollowUpResult = 'none' | 'task' | 'template' | 'template_task';

export interface FollowUpInput {
  readonly form: FormRow;
  readonly contactId: string;
  readonly name: string;
  /** Teléfono en E.164. */
  readonly phone: string;
  /** Responsable del lead (cola o el que ya tenía el contacto); sin él no hay a quién asignarle la tarea. */
  readonly ownerId: string | null;
  readonly now: Date;
}

/** El valor de una variable de la plantilla: el texto con `{{nombre}}`, `{{primer_nombre}}` y `{{formulario}}` reemplazados; lo demás tal cual. Una línea y acotado (Meta rechaza saltos de línea). */
export function resolveParam(template: string, v: { name: string; formName: string }): string {
  const first = v.name.trim().split(/\s+/)[0] ?? '';
  return template
    .replace(/\{\{\s*nombre\s*\}\}/gi, v.name)
    .replace(/\{\{\s*primer_nombre\s*\}\}/gi, first)
    .replace(/\{\{\s*formulario\s*\}\}/gi, v.formName)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** La tarea del lead: cuánto tiempo tiene el responsable para contactarlo. */
export const FOLLOW_UP_TASK_DUE_MS = 60 * 60_000;

/**
 * Seguimiento automático de un envío de formulario (M9.2, ADR-09/54; F07). Corre DENTRO de la transacción del envío: o queda todo o nada. Dos piezas independientes:
 *  - **Plantilla de WhatsApp** (si el formulario la tiene): abre la conversación con el lead (sin conversación previa, la nueva queda con su responsable «pendiente»), y deja el mensaje de plantilla en cola
 *    como mensaje automático (lo envía la tarea de siempre; no cuenta como respuesta humana). Solo si el contacto no revocó su consentimiento, la conexión está activa y la plantilla existe, sigue
 *    aprobada y sus valores son válidos; si algo falla **no se pierde el lead**: queda la tarea.
 *  - **Tarea** para el responsable («Contactar a …»), que vence en una hora; sin responsable no hay a quién asignarla; no se repite si ya hay una igual abierta para ese contacto.
 * El agente de IA no necesita configuración aquí: si la conexión tiene uno activo, atiende lo que el lead conteste.
 */
@Injectable()
export class FormFollowUpService {
  constructor(@Inject(OutreachService) private readonly outreach: OutreachService) {}

  async run(tx: TenantTx, i: FollowUpInput): Promise<FollowUpResult> {
    const sent = i.form.followUpChannelId && i.form.followUpTemplateId ? await this.sendTemplate(tx, i, i.form.followUpChannelId, i.form.followUpTemplateId) : false;
    const task = i.form.followUpTask ? await this.createTask(tx, i) : false;
    return sent ? (task ? 'template_task' : 'template') : task ? 'task' : 'none';
  }

  /** Deja la plantilla en cola; false si no se pudo por cualquier motivo previsible (el lead no se pierde: queda la tarea). */
  private async sendTemplate(tx: TenantTx, i: FollowUpInput, channelId: string, templateId: string): Promise<boolean> {
    const params = Object.fromEntries(Object.entries(i.form.followUpParams).map(([k, v]) => [k, resolveParam(v, { name: i.name, formName: i.form.name })]));
    const r = await this.outreach.sendTemplate(tx, { contactId: i.contactId, phone: i.phone, channelId, templateId, params, queueId: i.form.queueId, ownerId: i.ownerId, now: i.now });
    return r.sent;
  }

  /** La tarea para el responsable; false si no hay responsable o ya existe una igual abierta (de las últimas 24 h). */
  private async createTask(tx: TenantTx, i: FollowUpInput): Promise<boolean> {
    if (!i.ownerId) return false;
    const title = `Contactar a ${i.name} (formulario «${i.form.name}»)`.slice(0, 200);
    const since = new Date(i.now.getTime() - 86_400_000);
    const [dup] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.contactId, i.contactId), eq(tasks.status, 'open'), isNull(tasks.deletedAt), gt(tasks.createdAt, since), eq(tasks.title, title))).limit(1);
    if (dup) return false;
    const dueAt = new Date(i.now.getTime() + FOLLOW_UP_TASK_DUE_MS);
    const [t] = await tx
      .insert(tasks)
      .values({ title, description: `Llegó por el formulario «${i.form.name}». Escríbele o llámalo cuanto antes.`, dueAt, assigneeId: i.ownerId, contactId: i.contactId, createdBy: i.ownerId })
      .returning({ id: tasks.id });
    await writeAudit(tx, { entityType: 'task', entityId: t!.id, newValue: { title, due_at: dueAt.toISOString(), assignee_id: i.ownerId, contact_id: i.contactId, has_description: true }, source: 'api' });
    return true;
  }
}
