import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { Database, notifications, tasks, type TenantTx } from '../../db';
import { TenantContext } from '../../tenant';
import { RealtimeService } from '../realtime';

/** A quién se le creó un aviso (para el aviso en vivo, que sale DESPUÉS de confirmar la transacción). */
export interface TaskNotice {
  readonly userId: string;
  readonly notificationId: string;
}

/** Cuántas tareas por vuelta (la siguiente vuelta, un minuto después, sigue con el resto). */
const BATCH = 200;
/** Espera antes del aviso en vivo de una tarea creada por el sistema (da tiempo a que su transacción confirme). */
const SYSTEM_PUSH_DELAY_MS = 2_000;

/**
 * Avisos de tareas (F2, ADR-58): «te asignaron una tarea» y «tu tarea vence». Es el segundo productor del centro de avisos (ADR-57). Módulo propio y sin dependencias de contactos ni conversaciones para
 * que los cuatro sitios que crean tareas (pantalla, automatizaciones, agente de IA y seguimiento de formularios) puedan llamarlo sin ciclos. El aviso es de UNA persona y no guarda texto: el título se
 * lee de la tarea al pedir la lista.
 */
@Injectable()
export class TaskNoticesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /**
   * «Te asignaron una tarea», dentro de la transacción que la crea o la reasigna. `actorId` es quien la asigna (`null` si la crea el sistema: automatización, agente de IA, formulario). Quien se la asigna
   * a sí mismo no recibe aviso. Repetirlo (misma persona y tarea) no duplica. Devuelve a quién se avisó, para el aviso en vivo.
   */
  async assigned(tx: TenantTx, input: { taskId: string; assigneeId: string; actorId: string | null }): Promise<TaskNotice | null> {
    if (input.actorId !== null && input.actorId === input.assigneeId) return null;
    const [row] = await tx
      .insert(notifications)
      .values({ userId: input.assigneeId, type: 'task_assigned', actorId: input.actorId, taskId: input.taskId })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    return row ? { userId: input.assigneeId, notificationId: row.id } : null;
  }

  /**
   * «Se te asignó una tarea» cuando la crea el SISTEMA (automatización, agente de IA, seguimiento de formulario), sin actor. Esos sitios crean la tarea dentro de una transacción más grande que no controlan,
   * así que el aviso en vivo sale unos segundos después, cuando ya se confirmó; si no alcanzara, la consulta de respaldo de la campana lo trae igual (el aviso en vivo solo lleva un id y el cliente vuelve a pedir la lista).
   */
  async assignedBySystem(tx: TenantTx, input: { taskId: string; assigneeId: string }): Promise<void> {
    const notice = await this.assigned(tx, { ...input, actorId: null });
    if (!notice) return;
    const organizationId = TenantContext.current().organizationId;
    setTimeout(() => this.realtime.notify(organizationId, [notice]), SYSTEM_PUSH_DELAY_MS).unref();
  }

  /** Avisa en vivo de lo que acaba de confirmarse (nunca lanza). */
  push(notices: ReadonlyArray<TaskNotice | null>): void {
    const items = notices.filter((n): n is TaskNotice => n !== null);
    if (items.length === 0) return;
    this.realtime.notify(TenantContext.current().organizationId, items);
  }

  /**
   * Los avisos de vencimiento que ya tocan, de la empresa del contexto: por cada tarea abierta cuyo `notice_at` llegó se crea UN aviso para su responsable (si todavía puede recibir trabajo) y se limpia
   * `notice_at`. `SKIP LOCKED` y el aviso único por persona, tarea y tipo hacen seguro que dos procesos o una repetición coincidan. Devuelve cuántas tareas procesó.
   */
  async runDue(now: Date, assignable: ReadonlySet<string>): Promise<number> {
    const created: TaskNotice[] = [];
    const processed = await this.db.withTenant(async (tx) => {
      const due = await tx
        .select({ id: tasks.id, assigneeId: tasks.assigneeId })
        .from(tasks)
        .where(and(isNotNull(tasks.noticeAt), lte(tasks.noticeAt, now), eq(tasks.status, 'open'), isNull(tasks.deletedAt)))
        .orderBy(asc(tasks.noticeAt))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      for (const t of due) {
        if (assignable.has(t.assigneeId)) {
          const [row] = await tx.insert(notifications).values({ userId: t.assigneeId, type: 'task_due', taskId: t.id }).onConflictDoNothing().returning({ id: notifications.id });
          if (row) created.push({ userId: t.assigneeId, notificationId: row.id });
        }
        await tx.update(tasks).set({ noticeAt: null }).where(eq(tasks.id, t.id));
      }
      return due.length;
    });
    this.push(created);
    return processed;
  }
}
