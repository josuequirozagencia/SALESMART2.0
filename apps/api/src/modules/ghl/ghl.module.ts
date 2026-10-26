import { DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { ContactsModule } from '../contacts';
import { ConversationsModule } from '../conversations';
import { OrganizationsModule } from '../organizations';
import { TagsModule } from '../tags';
import { GhlChannelService } from './ghl-channel.service';
import { GhlConnectionService } from './ghl-connection.service';
import { GhlEventsJob } from './ghl-events.job';
import { GhlOutboundService } from './ghl-outbound.service';
import { GhlOutboxJob } from './ghl-outbox.job';
import { GhlOutboxService } from './ghl-outbox.service';
import { GhlEventsService } from './ghl-events.service';
import { GhlWebhookController } from './ghl-webhook.controller';
import { GhlWebhookService } from './ghl-webhook.service';
import { GhlController } from './ghl.controller';
import { FakeGhlProvider } from './ghl.fake';
import { GHL_PROVIDER, NoGhlProvider, type GhlProvider } from './ghl.ports';
import { PrivateTokenProvider } from './private-token.provider';

/**
 * GoHighLevel (M7, ADR-52). El adaptador se inyecta: `ghl` (Private Token) por omisión, `none` o `fake`; las pruebas registran el suyo con `GhlModule.register({ provider })`.
 */
@Module({})
export class GhlModule {
  private static standard: DynamicModule | undefined;

  /** Sin opciones devuelve SIEMPRE el mismo módulo (una sola instancia, sin rutas duplicadas). */
  static register(opts: { provider?: GhlProvider } = {}): DynamicModule {
    if (!opts.provider && GhlModule.standard) return GhlModule.standard;
    const mod: DynamicModule = {
      module: GhlModule,
      // Global: el despachador del Inbox necesita `GhlOutboundService` y no debe importar este módulo (así hay UNA sola instancia, también cuando las pruebas registran su propio adaptador)
      global: true,
      imports: [OrganizationsModule, ContactsModule, ConversationsModule, TagsModule],
      controllers: [GhlController, GhlWebhookController],
      providers: [
        GhlConnectionService,
        GhlChannelService,
        GhlOutboundService,
        GhlEventsService,
        GhlWebhookService,
        GhlEventsJob,
        GhlOutboxService,
        GhlOutboxJob,
        opts.provider
          ? { provide: GHL_PROVIDER, useValue: opts.provider }
          : { provide: GHL_PROVIDER, useFactory: (cfg: AppConfig): GhlProvider => (cfg.channels.ghlProvider === 'ghl' ? new PrivateTokenProvider() : cfg.channels.ghlProvider === 'fake' ? new FakeGhlProvider() : new NoGhlProvider()), inject: [APP_CONFIG] },
      ],
      exports: [GhlConnectionService, GhlChannelService, GhlOutboundService, GhlEventsService, GhlEventsJob, GhlOutboxService, GhlOutboxJob],
    };
    if (!opts.provider) GhlModule.standard = mod;
    return mod;
  }
}
