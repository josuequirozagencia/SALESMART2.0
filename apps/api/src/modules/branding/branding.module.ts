import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments';
import { PlatformModule } from '../platform';
import { BrandingController, BrandingPublicController } from './branding.controller';
import { BrandingService } from './branding.service';

/**
 * Marca de la plataforma (v11 S3): el favicon. Aparte del módulo de plataforma porque necesita el almacenamiento (`AttachmentsModule`) y ese ya depende de plataforma; la referencia en
 * base de datos la toca solo `BrandingStore` (dentro de plataforma, lint P10).
 */
@Module({ imports: [PlatformModule, AttachmentsModule], controllers: [BrandingController, BrandingPublicController], providers: [BrandingService] })
export class BrandingModule {}
