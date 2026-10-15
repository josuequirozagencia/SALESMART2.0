import { Body, Controller, Header, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { PlatformOnly, Public, ZodValidationPipe } from '../../../http';
import { RequirePermission } from '../../../rbac';
import { acceptInvitationSchema, createCompanySchema, invitationTokenSchema, type AcceptInvitationDto, type CreateCompanyDto, type InvitationTokenDto } from './invitations.dto';
import { InvitationsService } from './invitations.service';

const uuidParam = new ZodValidationPipe(z.uuid());

/**
 * «Nueva empresa» y reenvío de la invitación (solo Súper Admin). `no-store`: la respuesta puede traer el enlace de invitación cuando el
 * correo no salió (ADR-39 #5), y no debe quedar en cachés.
 */
@PlatformOnly()
@RequirePermission('platform.companies.manage')
@Controller('platform/companies')
export class PlatformInvitationsController {
  constructor(@Inject(InvitationsService) private readonly invitations: InvitationsService) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(createCompanySchema)) b: CreateCompanyDto) {
    return this.invitations.createCompany(b);
  }

  /** El id es el de la empresa a administrar (ruta), no el de la propia organización del principal. */
  @Post(':id/invitation/resend')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  resend(@Param('id', uuidParam) id: string) {
    return this.invitations.resend(id);
  }
}

/** Vista previa y aceptación de la invitación: públicas (el token de 256 bits es la credencial); límite por IP y errores uniformes. */
@Public()
@Controller('auth/invitations')
export class InvitationsController {
  constructor(@Inject(InvitationsService) private readonly invitations: InvitationsService) {}

  @Post('preview')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  preview(@Body(new ZodValidationPipe(invitationTokenSchema)) b: InvitationTokenDto, @Req() req: Request) {
    return this.invitations.preview({ token: b.token, ...(req.ip ? { ip: req.ip } : {}) });
  }

  @Post('accept')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  accept(@Body(new ZodValidationPipe(acceptInvitationSchema)) b: AcceptInvitationDto, @Req() req: Request) {
    return this.invitations.accept({ token: b.token, password: b.password, ...(b.full_name ? { fullName: b.full_name } : {}), ...(b.phone ? { phone: b.phone } : {}), ...(req.ip ? { ip: req.ip } : {}) });
  }
}
