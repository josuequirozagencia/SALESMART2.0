import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments';
import { AdsController } from './ads.controller';
import { AdsService } from './ads.service';

/** Anuncios de Meta de la empresa: titular, texto, red y miniatura por id de anuncio (v20, ADR-55). */
@Module({ imports: [AttachmentsModule], controllers: [AdsController], providers: [AdsService], exports: [AdsService] })
export class AdsModule {}
