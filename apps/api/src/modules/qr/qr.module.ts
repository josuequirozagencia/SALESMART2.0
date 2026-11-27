import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { AttachmentsModule } from '../attachments';
import { ChannelsModule } from '../channels';
import { ConversationsModule } from '../conversations';
import { ConnectionQueueModule } from '../connection-queue';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import { AdBackfillJob } from './ad-backfill.job';
import { AdBackfillService } from './ad-backfill.service';
import { AdCreativesService } from './ad-creatives.service';
import { ContactPhotosJob } from './contact-photos.job';
import { EvolutionProvider } from './evolution.provider';
import { HttpPhotoDownloader, PHOTO_DOWNLOADER } from './photo-downloader';
import { QrCatchUpJob } from './qr-catch-up.job';
import { QrCatchUpService } from './qr-catch-up.service';
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
  imports: [OrganizationsModule, PlatformModule, ChannelsModule, ConversationsModule, AttachmentsModule, ConnectionQueueModule],
  controllers: [QrController, QrWebhookController],
  providers: [
    QrConnectionsService,
    QrWebhookService,
    QrOutboundService,
    QrHeartbeatJob,
    QrCatchUpService,
    QrCatchUpJob,
    AdCreativesService,
    AdBackfillService,
    AdBackfillJob,
    ContactPhotosJob,
    { provide: PHOTO_DOWNLOADER, useClass: HttpPhotoDownloader },
    { provide: QR_SESSION, useFactory: (cfg: AppConfig): QrSessionProvider => (cfg.channels.qrProvider === 'fake' ? new FakeQrSession() : new EvolutionProvider()), inject: [APP_CONFIG] },
  ],
  exports: [QR_SESSION, QrConnectionsService, QrOutboundService, QrHeartbeatJob, QrCatchUpJob, AdBackfillJob, AdCreativesService, ContactPhotosJob],
})
export class QrModule {}
