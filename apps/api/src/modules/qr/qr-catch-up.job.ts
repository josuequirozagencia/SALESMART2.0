import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { channelAccounts, Database, qrAccounts } from '../../db';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { QrRoutesService } from '../organizations';
import { QrCatchUpService } from './qr-catch-up.service';
import { QrConnectionsService } from './qr-connections.service';

/**
 * Ponerse al día de las sesiones de WhatsApp por QR (v19 B3). Cada 10 minutos, por cada sesión ABIERTA, lee de Evolution lo que guardó en las últimas horas (hasta 48, solapando 15 min con la pasada
 * anterior) y pone en cola lo que la plataforma no tiene: cubre los avisos que Evolution no entregó o que se perdieron en un reinicio. Solo lectura sobre Evolution; lo que ya existe no se duplica.
 * Corre bajo el contexto de cada empresa; nunca registra teléfonos ni textos.
 */
@Injectable()
export class QrCatchUpJob implements ScheduledJob {
  readonly name = 'qr-catch-up';
  readonly intervalMs = 10 * 60_000;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QrRoutesService) private readonly routes: QrRoutesService,
    @Inject(QrConnectionsService) private readonly connections: QrConnectionsService,
    @Inject(QrCatchUpService) private readonly catchUp: QrCatchUpService,
  ) {}

  async run(now: Date): Promise<number> {
    let passes = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      passes += await TenantContext.run({ organizationId }, () => this.org(now));
    }
    return passes;
  }

  private async org(now: Date): Promise<number> {
    if (!(await this.connections.credentials())) return 0;
    const sessions = await this.db.withTenant((tx) =>
      tx
        .select({ id: qrAccounts.channelAccountId, last: qrAccounts.lastCatchUpAt })
        .from(qrAccounts)
        .innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, qrAccounts.organizationId), eq(channelAccounts.id, qrAccounts.channelAccountId)))
        .where(and(isNull(channelAccounts.deletedAt), eq(channelAccounts.status, 'active'), eq(qrAccounts.state, 'open'))),
    );
    let n = 0;
    for (const s of sessions) if ((await this.catchUp.auto(s.id, s.last, now)) !== null) n += 1;
    return n;
  }
}
