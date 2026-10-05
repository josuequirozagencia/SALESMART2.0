import { Module } from '@nestjs/common';
import { PlatformAuditService } from './platform-audit.service';

/** Módulo de plataforma (único autorizado a usar withPlatform, lint P10). M1.4 solo aporta la auditoría; M2 añade la consola. */
@Module({ providers: [PlatformAuditService], exports: [PlatformAuditService] })
export class PlatformModule {}
