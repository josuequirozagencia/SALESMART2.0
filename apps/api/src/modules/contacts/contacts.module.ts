import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations';
import { ContactsController } from './contacts.controller';
import { ContactsRepository } from './contacts.repository';
import { ContactsService } from './contacts.service';

/** Contactos del CRM (M3.1, ADR-43). Usa `OrgMembersService` (organizations) para las personas: las membresías son de identidad (ADR-25). */
@Module({ imports: [OrganizationsModule], controllers: [ContactsController], providers: [ContactsRepository, ContactsService], exports: [ContactsService] })
export class ContactsModule {}
