import { Body, Controller, Get, Header, HttpCode, Inject, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TooManyAttemptsError } from '../../errors';
import { Public, WindowLimiter, ZodValidationPipe } from '../../http';
import { RequirePermission } from '../../rbac';
import { CalendarConnectionService } from './calendar-connection.service';
import { CalendarSyncService } from './calendar-sync.service';
import { callbackQuerySchema, chooseSchema, startSchema, type CallbackQuery, type ChooseDto, type StartDto } from './calendar.dto';

/**
 * Conexión de la empresa con Google Calendar (v11 Pista G, 67a, ADR-67). Solo quien administra integraciones (`integrations.manage`); `no-store`: es una autorización. El token jamás se
 * devuelve y de la cuenta solo se ve el correo enmascarado.
 */
@Controller('calendar')
export class CalendarController {
  constructor(
    @Inject(CalendarConnectionService) private readonly calendar: CalendarConnectionService,
    @Inject(CalendarSyncService) private readonly sync: CalendarSyncService,
  ) {}

  /** La conexión y, aparte, cómo va la sincronización de las citas (pendientes, fallidas…). */
  @RequirePermission('integrations.manage')
  @Get('connection')
  @Header('Cache-Control', 'no-store')
  async connection() {
    return { ...(await this.calendar.get()), sync: await this.sync.stats() };
  }

  /** Vuelve a intentar las citas que fallaron al sincronizarse. */
  @RequirePermission('integrations.manage')
  @Post('sync/retry')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  retry() {
    return this.sync.retryFailed();
  }

  /** Devuelve la dirección de Google a la que la web manda a la persona. */
  @RequirePermission('integrations.manage')
  @Post('connection/start')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  start(@Body(new ZodValidationPipe(startSchema)) body: StartDto) {
    return this.calendar.start(body.mode);
  }

  @RequirePermission('integrations.manage')
  @Get('calendars')
  @Header('Cache-Control', 'no-store')
  calendars() {
    return this.calendar.listCalendars();
  }

  @RequirePermission('integrations.manage')
  @Put('connection/calendar')
  @Header('Cache-Control', 'no-store')
  choose(@Body(new ZodValidationPipe(chooseSchema)) body: ChooseDto) {
    return this.calendar.chooseCalendar(body.calendar_id);
  }

  @RequirePermission('integrations.manage')
  @Post('connection/disconnect')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  disconnect() {
    return this.calendar.disconnect();
  }
}

const CALLBACK_LIMIT = 60; // peticiones por minuto y por IP
const WINDOW_MS = 60_000;

/**
 * El regreso de Google (v11 Pista G, 67a). PÚBLICA: la credencial es el `state` firmado (se valida antes de hacer nada). Siempre responde con una redirección a la pantalla de Conexiones con un
 * resultado (`?calendar=…`), nunca con detalles; ni el código ni el estado se registran.
 */
@Public()
@Controller('integrations/google-calendar')
export class CalendarCallbackController {
  private readonly limiter = new WindowLimiter(CALLBACK_LIMIT, WINDOW_MS);

  constructor(@Inject(CalendarConnectionService) private readonly calendar: CalendarConnectionService) {}

  @Get('callback')
  async callback(@Query(new ZodValidationPipe(callbackQuerySchema)) q: CallbackQuery, @Req() req: Request, @Res() res: Response): Promise<void> {
    const gate = this.limiter.take(req.ip ?? '?');
    if (!gate.ok) throw new TooManyAttemptsError(gate.retryAfterSeconds);
    const to = await this.calendar.callback(q);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer'); // el código y el estado no deben salir en el encabezado Referer de la página siguiente
    res.redirect(302, to);
  }
}
