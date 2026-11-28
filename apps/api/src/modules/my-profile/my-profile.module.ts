import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { PlatformModule } from '../platform';
import { SlaModule } from '../sla';
import { MyProfileController } from './my-profile.controller';
import { MyProfileService } from './my-profile.service';

/** «Mi perfil» (V25, ADR-76). La identidad la toca solo `auth` (`MyProfileStore`); aquí se junta con el horario propio y la auditoría. */
@Module({ imports: [AuthModule, PlatformModule, SlaModule], controllers: [MyProfileController], providers: [MyProfileService] })
export class MyProfileModule {}
