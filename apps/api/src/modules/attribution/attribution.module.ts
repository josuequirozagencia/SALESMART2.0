import { DynamicModule, Module } from '@nestjs/common';
import { ContactsModule } from '../contacts';
import { OrganizationsModule } from '../organizations';
import { TagsModule } from '../tags';
import { AttributionEndpointController, AttributionWebhookController } from './attribution.controller';
import { AttributionService } from './attribution.service';
import { CapiSenderJob } from './capi-sender.job';
import { CapiSenderService } from './capi-sender.service';
import { CAPI_PROVIDER, NoCapiProvider, type CapiProvider } from './capi.ports';

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
      controllers: [AttributionWebhookController, AttributionEndpointController],
      providers: [AttributionService, CapiSenderService, CapiSenderJob, { provide: CAPI_PROVIDER, useValue: opts.capi ?? new NoCapiProvider() }],
      exports: [AttributionService, CapiSenderService, CapiSenderJob],
    };
    if (!opts.capi) AttributionModule.standard = mod;
    return mod;
  }
}
