import { Module } from '@nestjs/common';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformCredentialsReader } from './providers/credentials-reader';
import { ProvidersController } from './providers/providers.controller';
import { ProvidersService } from './providers/providers.service';

/** Módulo de plataforma (único autorizado a usar withPlatform, lint P10): auditoría de plataforma y proveedores (M2.6, ADR-42). */
@Module({ controllers: [ProvidersController], providers: [PlatformAuditService, PlatformCredentialsReader, ProvidersService], exports: [PlatformAuditService, PlatformCredentialsReader, ProvidersService] })
export class PlatformModule {}
