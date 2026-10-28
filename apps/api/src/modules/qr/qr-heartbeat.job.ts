import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { channelAccounts, Database, qrAccounts } from '../../db';
import type { ScheduledJob } from '../../jobs/scheduled-job';
import { TenantContext } from '../../tenant';
import { QrRoutesService } from '../organizations';
import { QrConnectionsService } from './qr-connections.service';
import { QR_SESSION, QrSessionError, type QrSessionProvider } from './qr-session.port';

/**
 * Latido de las sesiones de WhatsApp por QR (M9.6, ADR-54/ADR-31). Los avisos de Evolution pueden PERDERSE (el spike lo comprobó: no hay reintentos) y una sesión puede caerse sin avisar, así que cada
 * minuto se le pregunta a Evolution el estado de cada sesión ya vinculada y se corrige lo guardado. Una caída (o su recuperación) queda en la auditoría y se ve en la pantalla de conexiones y en el Inbox.
 * Si el servidor de Evolution no contesta NO se marca la sesión como caída (no se sabe): se deja lo último conocido. Corre bajo el contexto de cada empresa; nunca registra claves ni teléfonos.
 */
@Injectable()
export class QrHeartbeatJob implements ScheduledJob {
  readonly name = 'qr-heartbeat';
  readonly intervalMs = 60_000;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QrRoutesService) private readonly routes: QrRoutesService,
    @Inject(QrConnectionsService) private readonly connections: QrConnectionsService,
    @Inject(QR_SESSION) private readonly provider: QrSessionProvider,
  ) {}

  async run(now: Date): Promise<number> {
    let checked = 0;
    for (const organizationId of await this.routes.organizationIds()) {
      checked += await TenantContext.run({ organizationId }, () => this.org(now));
    }
    return checked;
  }

  private async org(now: Date): Promise<number> {
    const creds = await this.connections.credentials();
    if (!creds) return 0;
    const sessions = await this.db.withTenant((tx) =>
      tx
        .select({ id: qrAccounts.channelAccountId, instance: qrAccounts.instanceName })
        .from(qrAccounts)
        .innerJoin(channelAccounts, and(eq(channelAccounts.organizationId, qrAccounts.organizationId), eq(channelAccounts.id, qrAccounts.channelAccountId)))
        .where(and(isNull(channelAccounts.deletedAt), eq(channelAccounts.status, 'active'), ne(qrAccounts.state, 'created'))),
    );
    let n = 0;
    for (const s of sessions) {
      try {
        const state = await this.provider.state(creds, s.instance);
        await this.db.withTenant(async (tx) => {
          await this.connections.applyState(tx, s.id, { state, reason: null, phone: null, profileName: null }, now);
          await tx.update(qrAccounts).set({ lastHeartbeatAt: now }).where(eq(qrAccounts.channelAccountId, s.id));
        });
        n += 1;
      } catch (e) {
        if (e instanceof QrSessionError && e.code === 'not_found') {
          // Evolution ya no tiene la instancia: la sesión está caída hasta que se vuelva a vincular (la pantalla la recrea al pedir un QR)
          await this.db.withTenant((tx) => this.connections.applyState(tx, s.id, { state: 'closed', reason: null, phone: null, profileName: null }, now));
        } else if (!(e instanceof QrSessionError)) throw e;
        // unavailable / not_configured / rate_limited: no se sabe el estado real; se conserva el último
      }
    }
    return n;
  }
}
