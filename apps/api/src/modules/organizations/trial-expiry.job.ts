import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { APP_CONFIG } from '../../tokens';
import { TrialsService } from './trials.service';

/** Máximo de pruebas por transacción: bloqueos cortos y progreso aunque haya miles vencidas. */
export const TRIAL_EXPIRY_BATCH = 100;

/** Marca como vencidas las pruebas cuyo fin ya pasó. El acceso no depende de este job (se decide por la hora). */
@Injectable()
export class TrialExpiryJob implements ScheduledJob {
  readonly name = 'trial-expiry';
  readonly intervalMs: number;

  constructor(
    @Inject(TrialsService) private readonly trials: TrialsService,
    @Inject(APP_CONFIG) cfg: AppConfig,
  ) {
    this.intervalMs = cfg.jobs.trialExpiryIntervalMs;
  }

  run(now: Date): Promise<number> {
    return this.trials.expireDue(now, TRIAL_EXPIRY_BATCH);
  }
}
