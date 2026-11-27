import { Controller, Delete, Header, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import type { ContactScope } from '../contacts';
import { LeadMarkService } from './lead-mark.service';

const idParam = new ZodValidationPipe(z.uuid());
/** El alcance sale de los permisos VERIFICADOS del principal (igual que en contactos): sin `contacts.view_all` solo se tocan los contactos propios. */
const scopeOf = (req: AuthedRequest): ContactScope => ({ viewAll: req.principal?.permissions?.has('contacts.view_all') === true });

/** Colocar o quitar la etiqueta del sistema «Lead» de un contacto. Al colocarla sale el Lead a Meta (una vez por contacto). Mismo permiso y alcance que editar un contacto. */
@Controller('contacts')
export class LeadMarkController {
  constructor(@Inject(LeadMarkService) private readonly lead: LeadMarkService) {}

  @RequirePermission('contacts.write')
  @Put(':id/lead')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  mark(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.lead.set(scopeOf(req), id, true);
  }

  @RequirePermission('contacts.write')
  @Delete(':id/lead')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  unmark(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.lead.set(scopeOf(req), id, false);
  }
}
