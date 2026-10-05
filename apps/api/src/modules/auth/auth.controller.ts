import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { ForbiddenError, UnauthorizedError } from '../../errors';
import { Public, ZodValidationPipe } from '../../http';
import { AuthService } from './auth.service';
import { CSRF_HEADER, CSRF_VALUE, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from './auth.constants';
import { loginSchema, tokenBodySchema, type LoginDto, type TokenBodyDto } from './auth.dto';
import type { IssuedTokens } from './session.service';

const readCookie = (req: Request, name: string): string | undefined => {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
};

/** Endpoints de acceso. Son @Public(): no hay sesión todavía; se protegen con límite de intentos y errores genéricos. */
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodValidationPipe(loginSchema)) body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login({ email: body.email, password: body.password, ip: req.ip, userAgent: req.header('user-agent') });
    this.noStore(res);
    const viaBody = body.token_transport === 'body';
    if (!viaBody) this.setCookie(res, r.tokens);
    return {
      access_token: r.tokens.accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor((r.tokens.accessExpiresAt.getTime() - Date.now()) / 1000),
      ...(viaBody ? { refresh_token: r.tokens.refreshToken } : {}),
      user: r.user,
      organization: r.organization,
      role: r.role,
    };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body(new ZodValidationPipe(tokenBodySchema)) body: TokenBodyDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { token, viaCookie } = this.refreshInput(req, body);
    if (viaCookie) this.requireCsrf(req);
    const r = await this.auth.refresh(token).catch((e: unknown) => {
      if (viaCookie && e instanceof UnauthorizedError) this.clearCookie(res);
      throw e;
    });
    this.noStore(res);
    if (viaCookie) this.setCookie(res, r.tokens);
    return {
      access_token: r.tokens.accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor((r.tokens.accessExpiresAt.getTime() - Date.now()) / 1000),
      ...(viaCookie ? {} : { refresh_token: r.tokens.refreshToken }),
    };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body(new ZodValidationPipe(tokenBodySchema)) body: TokenBodyDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const { token, viaCookie } = this.refreshInput(req, body);
    if (viaCookie) this.requireCsrf(req);
    // También acepta el access token en Authorization (clientes nativos); siempre responde 204
    const bearer = /^Bearer (.+)$/i.exec(req.header('authorization') ?? '')?.[1];
    await this.auth.logout(token ?? bearer);
    this.clearCookie(res);
  }

  private refreshInput(req: Request, body: TokenBodyDto): { token: string | undefined; viaCookie: boolean } {
    const fromBody = body.refresh_token;
    if (fromBody) return { token: fromBody, viaCookie: false };
    const c = readCookie(req, REFRESH_COOKIE);
    return { token: c, viaCookie: c !== undefined };
  }

  /** CSRF para peticiones que dependen de la cookie: cabecera personalizada (un formulario cross-site no puede enviarla). */
  private requireCsrf(req: Request): void {
    if (req.header(CSRF_HEADER) !== CSRF_VALUE) throw new ForbiddenError('CSRF', 'Solicitud no permitida');
  }

  private noStore(res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
  }

  private setCookie(res: Response, t: IssuedTokens): void {
    res.cookie(REFRESH_COOKIE, t.refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.cfg.nodeEnv === 'production',
      path: REFRESH_COOKIE_PATH,
      expires: t.refreshExpiresAt,
    });
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { httpOnly: true, sameSite: 'strict', secure: this.cfg.nodeEnv === 'production', path: '/auth' });
  }
}
