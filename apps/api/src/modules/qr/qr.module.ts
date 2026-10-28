import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { AttachmentsModule } from '../attachments';
import { ChannelsModule } from '../channels';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import { EvolutionProvider } from './evolution.provider';
import { QrConnectionsService } from './qr-connections.service';
import { QrHeartbeatJob } from './qr-heartbeat.job';
import { QrOutboundService } from './qr-outbound.service';
import { FakeQrSession } from './qr-session.fake';
import { QR_SESSION, type QrSessionProvider } from './qr-session.port';
import { QrWebhookController } from './qr-webhook.controller';
import { QrWebhookService } from './qr-webhook.service';
import { QrController } from './qr.controller';

/**
 * WhatsApp por QR (M9.6, ADR-54/ADR-31; canal NO OFICIAL): conexiones por QR sobre Evolution API, entrada de avisos por webhook, envío con calentamiento y cola cuando la sesión cae, y latido de la sesión.
 * El adaptador es `evolution` (con la URL y la clave que el Súper Admin guarda en Proveedores) o `fake` (desarrollo y pruebas). Módulo aparte para no cruzar canales con adjuntos.
 */
@Module({
  imports: [OrganizationsModule, PlatformModule, ChannelsModule, AttachmentsModule],
  controllers: [QrController, QrWebhookController],
  providers: [
    QrConnectionsService,
    QrWebhookService,
    QrOutboundService,
    QrHeartbeatJob,
    { provide: QR_SESSION, useFactory: (cfg: AppConfig): QrSessionProvider => (cfg.channels.qrProvider === 'fake' ? new FakeQrSession() : new EvolutionProvider()), inject: [APP_CONFIG] },
  ],
  exports: [QR_SESSION, QrConnectionsService, QrOutboundService, QrHeartbeatJob],
})
export class QrModule {}
