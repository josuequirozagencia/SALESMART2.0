import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/** Tablero y analítica (M6.5, ADR-51): solo lee y agrega lo que ya existe. */
@Module({ imports: [OrganizationsModule], controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
