import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { ConversationsModule } from '../conversations';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import { ChannelVault } from './channel-vault.service';
import { ChannelsController } from './channels.controller';
import { ConnectionsService } from './connections.service';
import { MetaCloudProvider } from './meta-cloud.provider';
import { MetaWebhookController } from './meta-webhook.controller';
import { MetaWebhookService } from './meta-webhook.service';
import { WebhookEventsJob } from './webhook-events.job';
import { WebhookEventsService } from './webhook-events.service';
import { FakeWhatsAppProvider } from './whatsapp.fake';
import { WHATSAPP_PROVIDER } from './whatsapp.port';

/**
 * Canales de mensajería (M5, ADR-50): conexiones de WhatsApp oficial, el adaptador del proveedor ('meta' real o 'fake' en desarrollo y pruebas) y la entrada de
 * avisos por el webhook de Meta (M5.2).
 */
@Module({
  imports: [OrganizationsModule, PlatformModule, ConversationsModule],
  controllers: [ChannelsController, MetaWebhookController],
  providers: [
    ChannelVault,
    ConnectionsService,
    MetaWebhookService,
    WebhookEventsService,
    WebhookEventsJob,
    { provide: WHATSAPP_PROVIDER, useFactory: (cfg: AppConfig) => (cfg.channels.whatsappProvider === 'fake' ? new FakeWhatsAppProvider() : new MetaCloudProvider()), inject: [APP_CONFIG] },
  ],
  exports: [WHATSAPP_PROVIDER, ChannelVault, WebhookEventsService, WebhookEventsJob],
})
export class ChannelsModule {}
