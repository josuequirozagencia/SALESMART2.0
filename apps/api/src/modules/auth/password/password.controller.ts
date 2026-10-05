import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthorizedError } from '../../../errors';
import { Public, SelfService, ZodValidationPipe } from '../../../http';
import type { AuthedRequest } from '../../../http/access.guard';
import { AuditService } from '../../audit';
import { PlatformAuditService } from '../../platform';
import { changePasswordSchema, forgotSchema, resetSchema, type ChangePasswordDto, type ForgotDto, type ResetDto } from './password.dto';
import { PasswordService } from './password.service';

@Controller('auth')
export class PasswordController {
  constructor(
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PlatformAuditService) private readonly platformAudit: PlatformAuditService,
  ) {}

  /** Siempre 202 con el mismo cuerpo, exista o no la cuenta. */
  @Public()
  @Post('forgot')
  @HttpCode(202)
  async forgot(@Body(new ZodValidationPipe(forgotSchema)) b: ForgotDto, @Req() req: Request) {
    await this.passwords.forgot({ email: b.email, captchaToken: b.captcha_token, ...(req.ip ? { ip: req.ip } : {}) });
    return { status: 'reset_requested' };
  }

  @Public()
  @Post('reset')
  @HttpCode(200)
  async reset(@Body(new ZodValidationPipe(resetSchema)) b: ResetDto, @Req() req: Request) {
    await this.passwords.reset({ token: b.token, newPassword: b.new_password, ...(req.ip ? { ip: req.ip } : {}) });
    return { status: 'password_updated' };
  }

  /** Autenticado: opera solo sobre el usuario y la sesión del principal verificado. */
  @SelfService()
  @Post('password')
  @HttpCode(204)
  async change(@Body(new ZodValidationPipe(changePasswordSchema)) b: ChangePasswordDto, @Req() req: AuthedRequest): Promise<void> {
    const p = req.principal;
    if (!p?.sessionId) throw new UnauthorizedError();
    await this.passwords.change({ userId: p.userId, sessionId: p.sessionId, currentPassword: b.current_password, newPassword: b.new_password });
    // Auditoría SIN valores (la contraseña jamás se registra): en la organización del cliente o en la de plataforma
    if (p.kind === 'tenant') await this.audit.record({ entityType: 'user', entityId: p.userId, field: 'password', source: 'manual' });
    else await this.platformAudit.record({ action: 'user.password_changed', entityType: 'user', entityId: p.userId });
  }
}
