import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields';
import { OrganizationsModule } from '../organizations';
import { TagsModule } from '../tags';
import { CompaniesService } from './companies.service';
import { CompaniesController, ContactCompaniesController, NotesController, TasksController } from './crm-extras.controller';
import { ContactExportController } from './contact-export.controller';
import { ContactExportService } from './contact-export.service';
import { ContactImportsController } from './contact-imports.controller';
import { ContactImportsRepository } from './contact-imports.repository';
import { ContactImportsService } from './contact-imports.service';
import { ContactListsController } from './contact-lists.controller';
import { ContactListsRepository } from './contact-lists.repository';
import { ContactListsService } from './contact-lists.service';
import { ContactsController } from './contacts.controller';
import { ContactsRepository } from './contacts.repository';
import { ContactsService } from './contacts.service';
import { NotesService } from './notes.service';
import { TasksService } from './tasks.service';

/** Contactos del CRM (M3.1, ADR-43) con sus campos personalizados (M3.2, ADR-44). Usa `OrgMembersService` (organizations) para las personas: las membresías son de identidad (ADR-25). */
@Module({ imports: [OrganizationsModule, CustomFieldsModule, TagsModule], controllers: [ContactsController, ContactListsController, ContactImportsController, ContactExportController, CompaniesController, ContactCompaniesController, NotesController, TasksController], providers: [ContactsRepository, ContactsService, ContactListsRepository, ContactListsService, ContactImportsRepository, ContactImportsService, ContactExportService, CompaniesService, NotesService, TasksService], exports: [ContactsService] })
export class ContactsModule {}
