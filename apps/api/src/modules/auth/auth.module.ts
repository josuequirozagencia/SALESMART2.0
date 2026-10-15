import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import type { AppConfig } from '../../config';
import type { AppLogger } from '../../logger';
import { APP_CONFIG, APP_LOGGER } from '../../tokens';
import { Argon2idHasher } from '../../security';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PASSWORD_HASHER } from './auth.tokens';
import { IdentityCleanupJob } from './identity-cleanup.job';
import { LocalAccessResolver } from './local-access.resolver';
import { SessionService } from './session.service';
import { PermissionService } from './permission.service';
import { PasswordController } from './password/password.controller';
import { PasswordService } from './password/password.service';
import { ThrottleService } from './throttle.service';
import { ConsoleMailProvider, FakeCaptchaVerifier, MemoryMailProvider, UnavailableCaptchaVerifier, UnavailableMailProvider } from './signup/fakes';
import { CAPTCHA_VERIFIER, MAIL_PROVIDER } from './signup/ports';
import { ResendMailProvider } from './signup/resend-mail.provider';
import { TurnstileVerifier } from './signup/turnstile.verifier';
import { InvitationsController, PlatformInvitationsController } from './invitations/invitations.controller';
import { InvitationsService } from './invitations/invitations.service';
import { SignupController } from './signup/signup.controller';
import { SignupLimiter } from './signup/signup-limiter';
import { SignupService } from './signup/signup.service';

@Module({
  imports: [AuditModule, PlatformModule, OrganizationsModule],
  controllers: [AuthController, SignupController, PasswordController, InvitationsController, PlatformInvitationsController],
  providers: [
    AuthService,
    SignupService,
    PasswordService,
    InvitationsService,
    PermissionService,
    SignupLimiter,
    // Proveedores reales (ADR-37): Resend y Turnstile. 'none' (503) o fakes de desarrollo/pruebas (la config los prohíbe en producción)
    {
      provide: MAIL_PROVIDER,
      useFactory: (cfg: AppConfig, log: AppLogger) => {
        switch (cfg.signup.mailProvider) {
          case 'resend': return new ResendMailProvider({ apiKey: cfg.providers.resendApiKey ?? '', from: cfg.providers.mailFrom ?? '' });
          case 'memory': return new MemoryMailProvider();
          case 'console': return new ConsoleMailProvider(log);
          default: return new UnavailableMailProvider();
        }
      },
      inject: [APP_CONFIG, APP_LOGGER],
    },
    {
      provide: CAPTCHA_VERIFIER,
      useFactory: (cfg: AppConfig) => {
        switch (cfg.signup.captchaProvider) {
          case 'turnstile': return new TurnstileVerifier({ secret: cfg.providers.turnstileSecret ?? '' });
          case 'fake': return new FakeCaptchaVerifier();
          default: return new UnavailableCaptchaVerifier();
        }
      },
      inject: [APP_CONFIG],
    },
     IdentityCleanupJob, SessionService, ThrottleService, LocalAccessResolver, { provide: PASSWORD_HASHER, useFactory: () => new Argon2idHasher() }],
  exports: [SessionService, LocalAccessResolver, PermissionService, IdentityCleanupJob],
})
export class AuthModule {}
