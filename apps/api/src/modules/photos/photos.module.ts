import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments';
import { OrganizationsModule } from '../organizations';
import { PhotosController } from './photos.controller';
import { PhotosService } from './photos.service';

/** Fotos de perfil de contactos (WhatsApp por QR) y de las personas del equipo (las sube cada una). */
@Module({ imports: [OrganizationsModule, AttachmentsModule], controllers: [PhotosController], providers: [PhotosService], exports: [PhotosService] })
export class PhotosModule {}
