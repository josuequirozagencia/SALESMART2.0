import { Body, Controller, Get, Header, Inject, Patch, Req } from '@nestjs/common';
import { SelfService, ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { updateMyProfileSchema, type UpdateMyProfileDto } from './my-profile.dto';
import { MyProfileService } from './my-profile.service';

/** «Mi perfil» (V25, ADR-76): cualquier persona autenticada, sobre sí misma. `no-store`: datos personales. */
@Controller('me')
export class MyProfileController {
  constructor(@Inject(MyProfileService) private readonly profile: MyProfileService) {}

  @SelfService()
  @Get('profile')
  @Header('Cache-Control', 'no-store')
  get(@Req() req: AuthedRequest) {
    return this.profile.get(req.principal);
  }

  @SelfService()
  @Patch('profile')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(updateMyProfileSchema)) b: UpdateMyProfileDto) {
    return this.profile.update(req.principal, b);
  }
}
