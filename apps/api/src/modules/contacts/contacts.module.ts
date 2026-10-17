import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields';
import { OrganizationsModule } from '../organizations';
import { TagsModule } from '../tags';
import { ContactListsController } from './contact-lists.controller';
import { ContactListsRepository } from './contact-lists.repository';
import { ContactListsService } from './contact-lists.service';
import { ContactsController } from './contacts.controller';
import { ContactsRepository } from './contacts.repository';
import { ContactsService } from './contacts.service';

/** Contactos del CRM (M3.1, ADR-43) con sus campos personalizados (M3.2, ADR-44). Usa `OrgMembersService` (organizations) para las personas: las membresías son de identidad (ADR-25). */
@Module({ imports: [OrganizationsModule, CustomFieldsModule, TagsModule], controllers: [ContactsController, ContactListsController], providers: [ContactsRepository, ContactsService, ContactListsRepository, ContactListsService], exports: [ContactsService] })
export class ContactsModule {}
