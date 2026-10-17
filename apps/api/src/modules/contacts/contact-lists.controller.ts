import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { createListSchema, membersSchema, updateListSchema, type CreateListDto, type MembersDto, type UpdateListDto } from './contact-lists.dto';
import { ContactListsService } from './contact-lists.service';

const idParam = new ZodValidationPipe(z.uuid());
/** Compartir y cambiar listas ajenas depende de `contacts.view_all`, verificado en el servidor (nunca viene de la petición). */
const viewAll = (req: AuthedRequest): boolean => req.principal?.permissions?.has('contacts.view_all') === true;

/**
 * Listas de contactos (M3.4, ADR-46). Ver va con `contacts.read`; crear y cambiar, con `contacts.write` (una agencia en solo lectura o una empresa con la prueba
 * vencida no cambia nada). Personales por defecto; compartir exige `contacts.view_all`.
 */
@Controller('contact-lists')
export class ContactListsController {
  constructor(@Inject(ContactListsService) private readonly lists: ContactListsService) {}

  @RequirePermission('contacts.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest) {
    return this.lists.list(viewAll(req));
  }

  @RequirePermission('contacts.write')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(createListSchema)) b: CreateListDto) {
    return this.lists.create(viewAll(req), b);
  }

  @RequirePermission('contacts.write')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateListSchema)) b: UpdateListDto) {
    return this.lists.update(viewAll(req), id, b);
  }

  @RequirePermission('contacts.write')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.lists.remove(viewAll(req), id);
  }

  @RequirePermission('contacts.write')
  @Post(':id/members')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  add(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(membersSchema)) b: MembersDto) {
    return this.lists.addMembers(viewAll(req), id, b);
  }

  @RequirePermission('contacts.write')
  @Post(':id/members/remove')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  removeMembers(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(membersSchema)) b: MembersDto) {
    return this.lists.removeMembers(viewAll(req), id, b);
  }
}
