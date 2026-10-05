import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { PlatformModule } from '../platform';
import type { AppConfig } from '../../config';
import type { AppLogger } from '../../logger';
import { APP_CONFIG, APP_LOGGER } from '../../tokens';
import { Argon2idHasher } from '../../security';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PASSWORD_HASHER } from './auth.tokens';
import { LocalAccessResolver } from './local-access.resolver';
import { SessionService } from './session.service';
import { PermissionService } from './permission.service';
import { PasswordController } from './password/password.controller';
import { PasswordService } from './password/password.service';
import { ThrottleService } from './throttle.service';
import { ConsoleMailProvider, FakeCaptchaVerifier, MemoryMailProvider, UnavailableCaptchaVerifier, UnavailableMailProvider } from './signup/fakes';
import { CAPTCHA_VERIFIER, MAIL_PROVIDER } from './signup/ports';
import { SignupController } from './signup/signup.controller';
import { SignupLimiter } from './signup/signup-limiter';
import { SignupService } from './signup/signup.service';

@Module({
  imports: [AuditModule, PlatformModule],
  controllers: [AuthController, SignupController, PasswordController],
  providers: [
    AuthService,
    SignupService,
    PasswordService,
    PermissionService,
    SignupLimiter,
    // Sin proveedor real elegido: solo 'none' (503) o fakes de desarrollo/pruebas (la config los prohíbe en producción)
    {
      provide: MAIL_PROVIDER,
      useFactory: (cfg: AppConfig, log: AppLogger) =>
        cfg.signup.mailProvider === 'memory' ? new MemoryMailProvider() : cfg.signup.mailProvider === 'console' ? new ConsoleMailProvider(log) : new UnavailableMailProvider(),
      inject: [APP_CONFIG, APP_LOGGER],
    },
    { provide: CAPTCHA_VERIFIER, useFactory: (cfg: AppConfig) => (cfg.signup.captchaProvider === 'fake' ? new FakeCaptchaVerifier() : new UnavailableCaptchaVerifier()), inject: [APP_CONFIG] },
     SessionService, ThrottleService, LocalAccessResolver, { provide: PASSWORD_HASHER, useFactory: () => new Argon2idHasher() }],
  exports: [SessionService, LocalAccessResolver, PermissionService],
})
export class AuthModule {}
