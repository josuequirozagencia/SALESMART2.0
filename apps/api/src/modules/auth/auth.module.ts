import { Module } from '@nestjs/common';
import { MailModule } from '../../mail';
import { AuditModule } from '../audit';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { Argon2idHasher } from '../../security';
import { AuthController } from './auth.controller';
import { AccessSessionsService } from './context/access-sessions.service';
import { ContextController, PlatformAccessSessionsController } from './context/context.controller';
import { ContextService } from './context/context.service';
import { AuthService } from './auth.service';
import { PASSWORD_HASHER } from './auth.tokens';
import { IdentityCleanupJob } from './identity-cleanup.job';
import { LocalAccessResolver } from './local-access.resolver';
import { SessionService } from './session.service';
import { PermissionService } from './permission.service';
import { PasswordController } from './password/password.controller';
import { PasswordService } from './password/password.service';
import { ThrottleService } from './throttle.service';
import { FakeCaptchaVerifier, UnavailableCaptchaVerifier } from './signup/fakes';
import { CAPTCHA_VERIFIER } from './signup/ports';
import { TurnstileVerifier } from './signup/turnstile.verifier';
import { AgencyClientRegistrationController, InvitationsController, PlatformAgencyCreationController, PlatformInvitationsController } from './invitations/invitations.controller';
import { InvitationsService } from './invitations/invitations.service';
import { SignupController } from './signup/signup.controller';
import { SignupLimiter } from './signup/signup-limiter';
import { SignupService } from './signup/signup.service';

@Module({
  imports: [AuditModule, PlatformModule, OrganizationsModule, MailModule],
  controllers: [AuthController, SignupController, PasswordController, InvitationsController, PlatformInvitationsController, PlatformAgencyCreationController, AgencyClientRegistrationController, ContextController, PlatformAccessSessionsController],
  providers: [
    AuthService,
    SignupService,
    PasswordService,
    InvitationsService,
    ContextService,
    AccessSessionsService,
    PermissionService,
    SignupLimiter,
    // Anti-bots (ADR-37): Turnstile. 'none' (503) o fake de desarrollo/pruebas (la config lo prohíbe en producción). El correo vive en MailModule.
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
  exports: [SessionService, LocalAccessResolver, PermissionService, IdentityCleanupJob, CAPTCHA_VERIFIER],
})
export class AuthModule {}
