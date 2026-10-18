import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { OrganizationsModule } from '../organizations';
import { ChannelVault } from './channel-vault.service';
import { ChannelsController } from './channels.controller';
import { ConnectionsService } from './connections.service';
import { MetaCloudProvider } from './meta-cloud.provider';
import { FakeWhatsAppProvider } from './whatsapp.fake';
import { WHATSAPP_PROVIDER } from './whatsapp.port';

/** Canales de mensajería (M5, ADR-50): conexiones de WhatsApp oficial y el adaptador del proveedor ('meta' real o 'fake' en desarrollo y pruebas). */
@Module({
  imports: [OrganizationsModule],
  controllers: [ChannelsController],
  providers: [
    ChannelVault,
    ConnectionsService,
    { provide: WHATSAPP_PROVIDER, useFactory: (cfg: AppConfig) => (cfg.channels.whatsappProvider === 'fake' ? new FakeWhatsAppProvider() : new MetaCloudProvider()), inject: [APP_CONFIG] },
  ],
  exports: [WHATSAPP_PROVIDER, ChannelVault],
})
export class ChannelsModule {}
