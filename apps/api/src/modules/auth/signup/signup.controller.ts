import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public, ZodValidationPipe } from '../../../http';
import { resendSchema, signupSchema, verifySchema, type ResendDto, type SignupDto, type VerifyDto } from './signup.dto';
import { SignupService } from './signup.service';

/** Registro público. Respuesta 202 idéntica exista o no la cuenta; verificación con error uniforme. */
@Public()
@Controller('auth')
export class SignupController {
  constructor(@Inject(SignupService) private readonly signup: SignupService) {}

  @Post('signup')
  @HttpCode(202)
  async register(@Body(new ZodValidationPipe(signupSchema)) b: SignupDto, @Req() req: Request) {
    await this.signup.signup({ email: b.email, password: b.password, organizationName: b.organization_name, ...(b.timezone ? { timezone: b.timezone } : {}), captchaToken: b.captcha_token, ...(req.ip ? { ip: req.ip } : {}) });
    return { status: 'verification_requested' };
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Body(new ZodValidationPipe(verifySchema)) b: VerifyDto, @Req() req: Request) {
    await this.signup.verify({ email: b.email, code: b.code, ...(req.ip ? { ip: req.ip } : {}) });
    return { status: 'verified' };
  }

  @Post('resend')
  @HttpCode(202)
  async resend(@Body(new ZodValidationPipe(resendSchema)) b: ResendDto, @Req() req: Request) {
    await this.signup.resend({ email: b.email, captchaToken: b.captcha_token, ...(req.ip ? { ip: req.ip } : {}) });
    return { status: 'verification_requested' };
  }
}
