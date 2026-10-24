import { DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { ContactsModule } from '../contacts';
import { OrganizationsModule } from '../organizations';
import { TagsModule } from '../tags';
import { AttributionEndpointController, AttributionWebhookController } from './attribution.controller';
import { AttributionService } from './attribution.service';
import { CapiSenderJob } from './capi-sender.job';
import { CapiSenderService } from './capi-sender.service';
import { FakeCapiProvider } from './capi.fake';
import { CAPI_PROVIDER, NoCapiProvider, type CapiProvider } from './capi.ports';
import { MetaCapiProvider } from './meta-capi.provider';
import { MetaSettingsController } from './meta-settings.controller';
import { MetaSettingsService } from './meta-settings.service';

/**
 * Atribución de Meta Ads y salida de eventos CAPI (M3.3, ADR-45). El proveedor de Conversions API se inyecta: hoy `none` (el adaptador real llega en M6);
 * las pruebas registran el fake con `AttributionModule.register({ capi })`.
 */
@Module({})
export class AttributionModule {
  private static standard: DynamicModule | undefined;

  /** Sin opciones devuelve SIEMPRE el mismo módulo (la app y las tareas lo importan: una sola instancia, sin rutas duplicadas). */
  static register(opts: { capi?: CapiProvider } = {}): DynamicModule {
    if (!opts.capi && AttributionModule.standard) return AttributionModule.standard;
    const mod: DynamicModule = {
      module: AttributionModule,
      imports: [ContactsModule, OrganizationsModule, TagsModule],
      controllers: [AttributionWebhookController, AttributionEndpointController, MetaSettingsController],
      providers: [
        AttributionService,
        CapiSenderService,
        CapiSenderJob,
        MetaSettingsService,
        opts.capi
          ? { provide: CAPI_PROVIDER, useValue: opts.capi }
          : { provide: CAPI_PROVIDER, useFactory: (cfg: AppConfig): CapiProvider => (cfg.channels.capiProvider === 'meta' ? new MetaCapiProvider() : cfg.channels.capiProvider === 'fake' ? new FakeCapiProvider() : new NoCapiProvider()), inject: [APP_CONFIG] },
      ],
      exports: [AttributionService, CapiSenderService, CapiSenderJob, MetaSettingsService],
    };
    if (!opts.capi) AttributionModule.standard = mod;
    return mod;
  }
}
