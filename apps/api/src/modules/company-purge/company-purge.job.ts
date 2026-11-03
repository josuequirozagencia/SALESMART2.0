import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import type { AppLogger } from '../../logger';
import { MAIL_PROVIDER, type MailProvider } from '../../mail';
import { APP_LOGGER } from '../../tokens';
import { CompanyPurgeStore, type PurgeJob } from '../auth';
import { CompanyPurgeService } from './company-purge.service';

/** Cuánto es «suyo» el trabajo sin dar señales de vida (otra instancia lo retoma pasado ese tiempo) y cada cuánto se renueva. */
const LEASE_MS = 5 * 60_000;
const HEARTBEAT_MS = 60_000;
/** Tiempo máximo de una ronda: lo que falte se retoma en la siguiente. */
const ROUND_BUDGET_MS = 9 * 60_000;

/**
 * Tarea de fondo del borrado definitivo (F3c, ADR-59 #10 y #14). Cada pasada: (1) avisa por correo a quien le falte menos de 24 horas para el borrado; (2) toma las eliminaciones cuyo plazo de 7 días venció y las borra, de
 * una en una, con arrendamiento (si el proceso muere, otra instancia lo retoma; lo ya borrado no se repite). Un fallo no detiene a los demás: la eliminación queda `purge_failed` y se reintenta con espera creciente.
 * Es el único otro caso, junto con «Descargar todo», en que se atiende a una empresa detenida: no recorre empresas, atiende eliminaciones concretas.
 */
@Injectable()
export class CompanyPurgeJob implements ScheduledJob {
  readonly name = 'company-purge';
  /** El ADR dice «cada hora»; cada 5 minutos el borrado no espera de más tras vencer el plazo y un reintento no tarda una hora (la tarea no hace nada si no hay nada que hacer). */
  readonly intervalMs = 5 * 60_000;

  constructor(
    @Inject(CompanyPurgeStore) private readonly store: CompanyPurgeStore,
    @Inject(CompanyPurgeService) private readonly service: CompanyPurgeService,
    @Inject(MAIL_PROVIDER) private readonly mail: MailProvider,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async run(now: Date): Promise<number> {
    let n = await this.notices(now);
    const started = Date.now();
    while (Date.now() - started < ROUND_BUDGET_MS) {
      const job = await this.store.claimDue(new Date(), LEASE_MS);
      if (!job) break;
      n += 1;
      if (!(await this.work(job))) break; // «hay más»: no se vuelve a tomar en esta ronda
    }
    return n;
  }

  /** `true` si terminó o falló (se puede seguir con otra empresa); `false` si quedó trabajo para la siguiente ronda. */
  private async work(job: PurgeJob): Promise<boolean> {
    const beat = (): Promise<void> => this.store.heartbeat(job.deletionId, new Date(Date.now() + LEASE_MS));
    const timer = setInterval(() => void beat().catch(() => undefined), HEARTBEAT_MS);
    timer.unref();
    try {
      const out = await this.service.purge(job, beat);
      if (out.kind === 'more') {
        await this.store.release(job.deletionId);
        return false;
      }
      if (out.kind === 'failed') {
        await this.store.fail(job.deletionId, out.code, new Date(), out.retryAfterMs);
        this.log.error({ deletionId: job.deletionId, code: out.code, attempts: job.attempts }, 'el borrado definitivo de una empresa falló (se reintenta)');
      }
      return true;
    } catch (e) {
      await this.store.fail(job.deletionId, 'PURGE_ERROR', new Date(), 30 * 60_000).catch(() => undefined);
      this.log.error({ err: e instanceof Error ? e.message : 'desconocido', deletionId: job.deletionId }, 'el borrado definitivo de una empresa falló (se reintenta)');
      return true;
    } finally {
      clearInterval(timer);
    }
  }

  /** «Mañana se borra»: un solo correo por eliminación, al dueño y a la agencia. Si no salió ninguno, se reintenta en la siguiente pasada. */
  private async notices(now: Date): Promise<number> {
    let n = 0;
    for (const d of await this.store.dueForNotice(now)) {
      let sent = 0;
      for (const r of d.recipients) {
        try {
          await this.mail.sendCompanyPurgeNotice({ to: r.email, organizationName: d.organizationName, purgeAfter: d.purgeAfter, timeZone: d.timezone, audience: r.audience });
          sent += 1;
        } catch (e) {
          this.log.error({ err: e instanceof Error ? e.message : 'desconocido', deletionId: d.deletionId }, 'no se pudo avisar del borrado definitivo');
        }
      }
      if (sent > 0 || d.recipients.length === 0) {
        await this.store.markNoticed(d.deletionId, now);
        n += 1;
      }
    }
    return n;
  }
}
