import { DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import { CalendarConnectionService } from './calendar-connection.service';
import { CalendarCallbackController, CalendarController } from './calendar.controller';
import { FakeCalendarProvider } from './calendar.fake';
import { CALENDAR_PROVIDER, NoCalendarProvider, type CalendarProvider } from './calendar.ports';
import { GoogleCalendarProvider } from './google-calendar.provider';

/**
 * Google Calendar (v11 Pista G, ADR-67). El adaptador se inyecta: `google` por omisión, `none` o `fake`; las pruebas registran el suyo con `CalendarModule.register({ provider })`. Sin opciones
 * devuelve SIEMPRE el mismo módulo (una sola instancia, sin rutas duplicadas).
 */
@Module({})
export class CalendarModule {
  private static standard: DynamicModule | undefined;

  static register(opts: { provider?: CalendarProvider } = {}): DynamicModule {
    if (!opts.provider && CalendarModule.standard) return CalendarModule.standard;
    const mod: DynamicModule = {
      module: CalendarModule,
      global: true,
      imports: [OrganizationsModule, PlatformModule],
      controllers: [CalendarController, CalendarCallbackController],
      providers: [
        CalendarConnectionService,
        opts.provider
          ? { provide: CALENDAR_PROVIDER, useValue: opts.provider }
          : { provide: CALENDAR_PROVIDER, useFactory: (cfg: AppConfig): CalendarProvider => (cfg.channels.calendarProvider === 'google' ? new GoogleCalendarProvider() : cfg.channels.calendarProvider === 'fake' ? new FakeCalendarProvider() : new NoCalendarProvider()), inject: [APP_CONFIG] },
      ],
      exports: [CalendarConnectionService],
    };
    if (!opts.provider) CalendarModule.standard = mod;
    return mod;
  }
}
