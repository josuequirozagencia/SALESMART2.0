import { Module } from '@nestjs/common';
import { DomainEventBus } from './domain-event.bus';

/** Los hechos del negocio que otros módulos anuncian y las automatizaciones escuchan (M9.3). No depende de nadie. */
@Module({ providers: [DomainEventBus], exports: [DomainEventBus] })
export class EventsModule {}
