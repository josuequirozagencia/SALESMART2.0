import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Options, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { TooManyAttemptsError } from '../../errors';
import { Public, WindowLimiter, ZodValidationPipe } from '../../http';
import { formPageCsp, formPageHtml } from './form-page';
import { FormSubmitService } from './form-submit.service';
import { publicSubmitSchema, type PublicSubmitDto } from './forms.dto';

const tokenParam = new ZodValidationPipe(z.uuid());
const MINUTE = 60_000;

/** Cabeceras CORS para un origen YA autorizado por el formulario (nunca `*`: cada formulario decide sus dominios). */
function cors(res: Response, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, idempotency-key');
  res.setHeader('Access-Control-Max-Age', '600');
}

/**
 * Entrada PÚBLICA de los formularios embebibles (M9.1, ADR-09/54; F07). Sin sesión: el token opaco de la URL solo permite LEER la definición pública y ENVIAR. Límites por minuto: por (IP, formulario)
 * para quien envía, por formulario en total (frena una avalancha de muchas IP) y por IP para leer la definición. Lo demás —dominio de origen, captcha, trampa, consentimiento, validación e idempotencia— lo
 * hace `FormSubmitService`. `no-store` en todo.
 */
@Public()
@Controller('public/forms')
export class FormsPublicController {
  private readonly perIp = new WindowLimiter(10, MINUTE);
  private readonly perForm = new WindowLimiter(300, MINUTE);
  private readonly reads = new WindowLimiter(120, MINUTE);

  constructor(@Inject(FormSubmitService) private readonly submits: FormSubmitService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  async definition(@Param('token', tokenParam) token: string, @Headers('origin') origin: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const gate = this.reads.take(`${req.ip ?? '?'}|${token}`);
    if (!gate.ok) throw new TooManyAttemptsError(gate.retryAfterSeconds);
    return this.submits.definition(token, origin, (o) => cors(res, o));
  }

  /** La página alojada: el enlace directo y lo que carga el iframe. Con su propia política de contenido (solo los dominios autorizados pueden incrustarla). */
  @Get(':token/page')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async page(@Param('token', tokenParam) token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<string> {
    const gate = this.reads.take(`${req.ip ?? '?'}|${token}`);
    if (!gate.ok) throw new TooManyAttemptsError(gate.retryAfterSeconds);
    const p = await this.submits.hostedPage(token);
    res.setHeader('Content-Security-Policy', formPageCsp(p.domains));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return formPageHtml({ name: p.name, token });
  }

  @Options(':token/submit')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async preflight(@Param('token', tokenParam) token: string, @Headers('origin') origin: string | undefined, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.submits.preflight(token, origin, (o) => cors(res, o));
  }

  @Post(':token/submit')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async submit(
    @Param('token', tokenParam) token: string,
    @Headers('origin') origin: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Body(new ZodValidationPipe(publicSubmitSchema)) body: PublicSubmitDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? null;
    const a = this.perIp.take(`${ip ?? '?'}|${token}`);
    if (!a.ok) throw new TooManyAttemptsError(a.retryAfterSeconds);
    const b = this.perForm.take(token);
    if (!b.ok) throw new TooManyAttemptsError(b.retryAfterSeconds);
    return this.submits.submit(token, origin, key, body, { ip, userAgent: userAgent ?? null }, (o) => cors(res, o));
  }
}
