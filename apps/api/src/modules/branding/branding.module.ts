import { Module } from '@nestjs/common';
import { WEB_BRAND } from '../../http';
import { AttachmentsModule } from '../attachments';
import { PlatformModule } from '../platform';
import { BrandingController, BrandingPublicController } from './branding.controller';
import { BrandingService } from './branding.service';

/**
 * Marca de la plataforma (v11 §3): nombre, logos e icono (favicon, instalación y notificaciones); ofrece al servidor web el nombre y la versión del icono para el HTML. Aparte del módulo de plataforma porque necesita el almacenamiento (`AttachmentsModule`) y ese ya depende de plataforma; la referencia en
 * base de datos la toca solo `BrandingStore` (dentro de plataforma, lint P10).
 */
@Module({ imports: [PlatformModule, AttachmentsModule], controllers: [BrandingController, BrandingPublicController], providers: [BrandingService, { provide: WEB_BRAND, useFactory: (b: BrandingService) => () => b.indexBrand(), inject: [BrandingService] }] })
export class BrandingModule {}
