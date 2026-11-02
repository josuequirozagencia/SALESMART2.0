import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { agents, automations, Database, forms, queues } from '../../db';
import { AppError } from '../../errors';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_LOGGER } from '../../tokens';
import { AgentsService } from '../ai';
import { AutomationsService } from '../automations';
import { orgReady } from '../auth';
import { FormsService } from '../forms';
import { SampleMarkService } from '../organizations';
import { QueuesService } from '../queues';

/** Las claves estables de los ejemplos (únicas por empresa): hacen idempotente su creación. */
export const SAMPLE_KEYS = { queue: 'general', agent: 'assistant', automation: 'welcome', form: 'contact' } as const;

export interface EnsureResult {
  /** ¿Están ya todos los ejemplos (creados ahora, creados antes o descartados por un nombre que el cliente ya usaba)? */
  complete: boolean;
}

/**
 * Datos de ejemplo de una empresa nueva (M10.6, ADR-56 B5): un departamento «General» (con el dueño), un agente de IA APAGADO y sin conexión, una automatización PAUSADA que solo crea
 * una tarea interna y un formulario en BORRADOR. Nada envía mensajes ni gasta créditos. Se crean justo DESPUÉS de que la empresa tiene su primer administrador activo (la aceptación
 * escribe en identidad y esto es de negocio: no pueden compartir transacción, ADR-25).
 *  - Cada ejemplo es idempotente por su `sample_key`: repetir `ensure` no duplica nada y completa lo que faltara (si algo falló, se reintenta en el siguiente acceso del administrador).
 *  - Si el cliente ya usa el mismo nombre, ese ejemplo se omite (no pisa nada suyo).
 *  - Cuando están todos se marca `organizations.sample_seeded_at`: lo que el cliente borre de ahí en adelante NO reaparece.
 */
@Injectable()
export class SampleDataService implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QueuesService) private readonly queues: QueuesService,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(AutomationsService) private readonly automations: AutomationsService,
    @Inject(FormsService) private readonly forms: FormsService,
    @Inject(SampleMarkService) private readonly mark: SampleMarkService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  /** El alta (registro propio o invitación del dueño) avisa aquí; los ejemplos se crean ya confirmada. */
  onModuleInit(): void {
    orgReady.register(async (e) => {
      await TenantContext.run({ organizationId: e.organizationId, userId: e.ownerUserId }, () => this.ensure());
    });
  }

  /** Crea lo que falte (dentro del contexto de la empresa). No hace nada si ya se marcó como hecho. */
  async ensure(): Promise<EnsureResult> {
    const { organizationId, userId } = TenantContext.current();
    if (await this.mark.isSeeded(organizationId)) return { complete: true };
    const have = await this.db.withTenant(async (tx) => ({
      queue: (await tx.select({ id: queues.id }).from(queues).where(eq(queues.sampleKey, SAMPLE_KEYS.queue)).limit(1)).length > 0,
      agent: (await tx.select({ id: agents.id }).from(agents).where(eq(agents.sampleKey, SAMPLE_KEYS.agent)).limit(1)).length > 0,
      automation: (await tx.select({ id: automations.id }).from(automations).where(eq(automations.sampleKey, SAMPLE_KEYS.automation)).limit(1)).length > 0,
      form: (await tx.select({ id: forms.id }).from(forms).where(eq(forms.sampleKey, SAMPLE_KEYS.form)).limit(1)).length > 0,
    }));

    const results = [
      have.queue || (await this.attempt('departamento', () => this.createQueue(userId))),
      have.agent || (await this.attempt('agente', () => this.createAgent())),
      have.automation || (await this.attempt('automatización', () => this.createAutomation())),
      have.form || (await this.attempt('formulario', () => this.createForm())),
    ];
    const complete = results.every(Boolean);
    if (complete) await this.mark.markSeeded(organizationId);
    return { complete };
  }

  /** Un ejemplo que no se pudo crear no impide los demás. Un nombre que el cliente ya usa (409) se da por resuelto: no se le pisa nada. */
  private async attempt(what: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof AppError && e.status === 409) return true;
      this.log.warn({ err: e instanceof Error ? e.message : 'desconocido', ejemplo: what }, 'no se pudo crear un dato de ejemplo (se reintenta en el siguiente acceso del administrador)');
      return false;
    }
  }

  private async createQueue(owner: string | undefined): Promise<void> {
    const q = await this.queues.create({ name: 'General', color: '#7c5cfa' });
    await this.db.withTenant((tx) => tx.update(queues).set({ isSample: true, sampleKey: SAMPLE_KEYS.queue }).where(eq(queues.id, q.id)));
    if (owner) await this.queues.setMembers(q.id, { members: [{ user_id: owner, active: true, weight: 1 }] }).catch((e: unknown) => this.log.warn({ err: e instanceof Error ? e.message : 'desconocido' }, 'el dueño no quedó en el departamento de ejemplo'));
  }

  private async createAgent(): Promise<void> {
    const a = await this.agents.create({ name: 'Asistente de ejemplo', role: 'Ejemplo: atiende preguntas frecuentes' });
    await this.agents.update(a.id, {
      personality: 'Eres un asistente amable y claro. Respondes en español, con frases cortas y sin inventar datos.',
      objective: 'Ayudar a los clientes con sus dudas y pasarlos con una persona cuando lo pidan.',
    });
    // Nace APAGADO y sin conexión (los agentes ya nacen así): no contesta nada ni gasta créditos hasta que el cliente lo decida
    await this.db.withTenant((tx) => tx.update(agents).set({ isSample: true, sampleKey: SAMPLE_KEYS.agent, active: false }).where(eq(agents.id, a.id)));
  }

  private async createAutomation(): Promise<void> {
    const r = await this.automations.create({
      name: 'Dar la bienvenida al contacto nuevo',
      description: 'Ejemplo (pausada): cuando entra un contacto nuevo, crea una tarea para que le des la bienvenida. No envía mensajes.',
      trigger: { type: 'contact_created', filter: {} },
      conditions: [],
      // Su ÚNICA acción es una tarea interna para el responsable: si se activa, solo crea tareas
      actions: [{ type: 'create_task', title: 'Dar la bienvenida al contacto nuevo', due_in_hours: 24, assignee: 'owner' }],
    });
    await this.db.withTenant((tx) => tx.update(automations).set({ isSample: true, sampleKey: SAMPLE_KEYS.automation, status: 'paused' }).where(eq(automations.id, r.id)));
  }

  private async createForm(): Promise<void> {
    const f = await this.forms.create({ name: 'Formulario de ejemplo', description: 'Ejemplo en borrador: captura nombre, WhatsApp y correo. Publícalo cuando quieras usarlo.' });
    await this.db.withTenant((tx) => tx.update(forms).set({ isSample: true, sampleKey: SAMPLE_KEYS.form }).where(eq(forms.id, f.id)));
  }
}
