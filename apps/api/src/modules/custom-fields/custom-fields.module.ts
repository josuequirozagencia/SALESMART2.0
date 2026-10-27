import { Module } from '@nestjs/common';
import { EventsModule } from '../events';
import { CustomFieldsController } from './custom-fields.controller';
import { CustomFieldsRepository } from './custom-fields.repository';
import { CustomFieldsService } from './custom-fields.service';
import { CustomValuesService } from './custom-values.service';

/** Campos personalizados tipados (M3.2, ADR-44). `CustomValuesService` lo usan los módulos que tienen la entidad (hoy `contacts`). */
@Module({
  imports: [EventsModule],
  controllers: [CustomFieldsController],
  providers: [CustomFieldsRepository, CustomFieldsService, CustomValuesService],
  exports: [CustomValuesService],
})
export class CustomFieldsModule {}
