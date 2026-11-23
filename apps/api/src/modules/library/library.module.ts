import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments';
import { OrganizationsModule } from '../organizations';
import { StorageModule } from '../storage';
import { LibraryController } from './library.controller';
import { LibraryService } from './library.service';

/** Biblioteca de archivos de la empresa (V21, ADR-75). */
@Module({
  imports: [AttachmentsModule, OrganizationsModule, StorageModule],
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
