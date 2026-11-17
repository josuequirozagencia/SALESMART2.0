import { Inject, Injectable } from '@nestjs/common';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import type { AppLogger } from '../../logger';
import { TenantContext } from '../../tenant';
import { APP_LOGGER } from '../../tokens';
import { ChannelRoutesService, QrRoutesService } from '../organizations';
import { ConnectionHealthService } from './connection-health.service';

/**
 * Alertas de salud de las conexiones (v19 B1/B4), cada 5 minutos y por empresa con alguna conexión de WhatsApp: si una conexión llega con mucho retraso, lleva horas sin avisos en horario laboral, tiene
 * avisos fallidos o su procesamiento va atrasado, a quienes administran las conexiones les llega UNA alerta en su centro de avisos; cuando se resuelve, se retira. Un fallo en una empresa no frena a las demás.
 */
@Injectable()
export class ConnectionHealthJob implements ScheduledJob {
  readonly name = 'connection-health';
  readonly intervalMs = 5 * 60_000;

  constructor(
    @Inject(ConnectionHealthService) private readonly health: ConnectionHealthService,
    @Inject(ChannelRoutesService) private readonly metaRoutes: ChannelRoutesService,
    @Inject(QrRoutesService) private readonly qrRoutes: QrRoutesService,
    @Inject(APP_LOGGER) private readonly log: AppLogger,
  ) {}

  async run(now: Date): Promise<number> {
    const orgs = new Set([...(await this.metaRoutes.organizationIds()), ...(await this.qrRoutes.organizationIds())]);
    let alerts = 0;
    for (const organizationId of orgs) {
      try {
        alerts += await TenantContext.run({ organizationId }, () => this.health.alertPass(now));
      } catch (e) {
        this.log.warn({ organization_id: organizationId, err: e instanceof Error ? e.name : 'desconocido' }, 'no se pudo evaluar la salud de las conexiones de una empresa');
      }
    }
    return alerts;
  }
}
