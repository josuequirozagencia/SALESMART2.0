import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { AppConfig } from '../config';
import type { AppLogger } from '../logger';
import { APP_CONFIG, APP_LOGGER } from '../tokens';
import { SCHEDULED_JOBS, type ScheduledJob } from './scheduled-job';

/**
 * Ejecutor de tareas periódicas dentro del proceso (ADR-33). Sin Redis ni colas externas: cada tarea es idempotente y
 * reparte su trabajo en lotes con `FOR UPDATE SKIP LOCKED`, de modo que varias instancias (API o worker) pueden correr
 * a la vez sin duplicar trabajo. `JOBS_ENABLED=false` lo apaga (p. ej. en la API cuando exista un worker aparte y en tests).
 *  - Nunca dos ejecuciones simultáneas de la misma tarea en este proceso.
 *  - Un fallo se registra y la tarea se reintenta en el siguiente intervalo; jamás tumba el proceso.
 *  - Al cerrar, espera a las ejecuciones en curso.
 */
@Injectable()
export class JobRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Map<string, Promise<number>>();
  private stopped = false;

  constructor(
    @Inject(SCHEDULED_JOBS) private readonly jobs: readonly ScheduledJob[],
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.cfg.jobs.enabled) return;
    for (const job of this.jobs) {
      const timer = setInterval(() => void this.tick(job), job.intervalMs);
      timer.unref(); // no mantiene vivo el proceso
      this.timers.push(timer);
      void this.tick(job); // primera pasada al arrancar: recupera lo que venció mientras estuvo caído
    }
  }

  /** Ejecuta una tarea ahora (pruebas, CLI). Si ya hay una en curso en este proceso, espera a esa y no lanza otra. */
  runOnce(name: string, now = new Date()): Promise<number> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) return Promise.reject(new Error(`tarea desconocida: ${name}`));
    return this.running.get(name) ?? this.execute(job, now);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    await Promise.allSettled([...this.running.values()]);
  }

  private async tick(job: ScheduledJob): Promise<void> {
    if (this.stopped || this.running.has(job.name)) return;
    try {
      await this.execute(job, new Date());
    } catch {
      /* ya registrado en execute */
    }
  }

  private execute(job: ScheduledJob, now: Date): Promise<number> {
    const p = (async () => {
      try {
        const n = await job.run(now);
        if (n > 0) this.log.info({ job: job.name, processed: n }, 'tarea periódica');
        return n;
      } catch (e) {
        this.log.error({ job: job.name, err: e instanceof Error ? e.message : 'desconocido' }, 'tarea periódica falló');
        throw e;
      } finally {
        this.running.delete(job.name);
      }
    })();
    this.running.set(job.name, p);
    return p;
  }
}
