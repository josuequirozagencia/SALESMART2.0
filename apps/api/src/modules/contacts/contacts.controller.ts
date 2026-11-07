import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { createContactSchema, listContactsQuerySchema, updateContactSchema, type CreateContactDto, type ListContactsQuery, type UpdateContactDto } from './contacts.dto';
import { ContactTouchesService } from './contact-touches';
import { ContactsService, type ContactScope } from './contacts.service';

const idParam = new ZodValidationPipe(z.uuid());
const bulkDeleteSchema = z.strictObject({ ids: z.array(z.uuid()).min(1).max(200) });

/** El alcance sale de los permisos VERIFICADOS del principal (nunca de la petición): sin `contacts.view_all` solo se ven y tocan los contactos propios. */
const scopeOf = (req: AuthedRequest): ContactScope => ({ viewAll: req.principal?.permissions?.has('contacts.view_all') === true });

/**
 * Qué puede hacer quien consulta, para que la UI muestre u oculte acciones SIN replicar la matriz de permisos. Es solo ayuda de presentación:
 * cada ruta vuelve a verificar su permiso en el servidor.
 */
const accessOf = (req: AuthedRequest): { view_all: boolean; write: boolean; delete: boolean; import: boolean; export: boolean } => {
  const has = (k: 'contacts.view_all' | 'contacts.write' | 'contacts.delete' | 'contacts.import' | 'contacts.export'): boolean => req.principal?.permissions?.has(k) === true;
  return { view_all: has('contacts.view_all'), write: has('contacts.write'), delete: has('contacts.delete'), import: has('contacts.import'), export: has('contacts.export') };
};

/**
 * Contactos (M3.1, ADR-43). Tenant: la organización sale del contexto verificado. `no-store`: son datos personales y no deben quedar en cachés.
 * El asesor ve y edita solo los suyos (alcance propio); `contacts.view_all` abre toda la organización; borrar exige `contacts.delete`.
 */
@Controller('contacts')
export class ContactsController {
  constructor(
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(ContactTouchesService) private readonly touchEvents: ContactTouchesService,
  ) {}

  @RequirePermission('contacts.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listContactsQuerySchema)) q: ListContactsQuery) {
    return { ...(await this.contacts.list(scopeOf(req), q)), access: accessOf(req) };
  }

  /** Personas a las que se puede asignar un contacto. Declarada ANTES de `:id`. */
  @RequirePermission('contacts.view_all')
  @Get('owners')
  @Header('Cache-Control', 'no-store')
  owners() {
    return this.contacts.owners();
  }

  /** Historial de toques (clics de anuncio, formularios y primer mensaje) del contacto, del más reciente al más antiguo (M6.6, ADR-55). */
  @RequirePermission('contacts.read')
  @Get(':id/touches')
  @Header('Cache-Control', 'no-store')
  touches(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.touchEvents.list(scopeOf(req), id);
  }

  @RequirePermission('contacts.read')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  one(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.contacts.get(scopeOf(req), id);
  }

  @RequirePermission('contacts.write')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(createContactSchema)) b: CreateContactDto) {
    return this.contacts.create(scopeOf(req), b);
  }

  @RequirePermission('contacts.write')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateContactSchema)) b: UpdateContactDto) {
    return this.contacts.update(scopeOf(req), id, b);
  }

  /** Borrado lógico de varios contactos (hasta 200) en una sola transacción; cada uno queda auditado. Los que no se ven o ya no existen salen en `skipped`. */
  @RequirePermission('contacts.delete')
  @Post('bulk-delete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  removeMany(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(bulkDeleteSchema)) b: { ids: string[] }) {
    return this.contacts.removeMany(scopeOf(req), b.ids);
  }

  /** Borrado lógico (el contacto se conserva, marcado). */
  @RequirePermission('contacts.delete')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.contacts.remove(scopeOf(req), id);
  }
}
