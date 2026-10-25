import { DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { ContactsModule } from '../contacts';
import { OrganizationsModule } from '../organizations';
import { TagsModule } from '../tags';
import { GhlConnectionService } from './ghl-connection.service';
import { GhlEventsJob } from './ghl-events.job';
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
      imports: [OrganizationsModule, ContactsModule, TagsModule],
      controllers: [GhlController, GhlWebhookController],
      providers: [
        GhlConnectionService,
        GhlEventsService,
        GhlWebhookService,
        GhlEventsJob,
        GhlOutboxService,
        GhlOutboxJob,
        opts.provider
          ? { provide: GHL_PROVIDER, useValue: opts.provider }
          : { provide: GHL_PROVIDER, useFactory: (cfg: AppConfig): GhlProvider => (cfg.channels.ghlProvider === 'ghl' ? new PrivateTokenProvider() : cfg.channels.ghlProvider === 'fake' ? new FakeGhlProvider() : new NoGhlProvider()), inject: [APP_CONFIG] },
      ],
      exports: [GhlConnectionService, GhlEventsService, GhlEventsJob, GhlOutboxService, GhlOutboxJob],
    };
    if (!opts.provider) GhlModule.standard = mod;
    return mod;
  }
}
