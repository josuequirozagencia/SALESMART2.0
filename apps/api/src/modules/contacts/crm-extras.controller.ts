import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { CompaniesService } from './companies.service';
import {
  companyContactsQuerySchema, createCompanySchema, createTaskSchema, linkContactsSchema, listCompaniesQuerySchema, listNotesQuerySchema, listTasksQuerySchema, noteBodySchema, updateCompanySchema, updateTaskSchema,
  type CompanyContactsQuery, type CreateCompanyDto, type CreateTaskDto, type LinkContactsDto, type ListCompaniesQuery, type ListNotesQuery, type ListTasksQuery, type NoteBodyDto, type UpdateCompanyDto, type UpdateTaskDto,
} from './crm-extras.dto';
import { NotesService, type NoteActor } from './notes.service';
import { TasksService } from './tasks.service';

const idParam = new ZodValidationPipe(z.uuid());
const has = (req: AuthedRequest, k: 'contacts.view_all' | 'contacts.write' | 'contacts.delete' | 'companies.manage'): boolean => req.principal?.permissions?.has(k) === true;
/** El alcance sale de los permisos VERIFICADOS del principal (nunca de la petición). */
const scopeOf = (req: AuthedRequest) => ({ viewAll: has(req, 'contacts.view_all') });
const actorOf = (req: AuthedRequest): NoteActor => ({ viewAll: has(req, 'contacts.view_all'), canDelete: has(req, 'contacts.delete') });

/**
 * Empresas del CRM (M3.6, ADR-48). Ver: `contacts.read`; crear, editar, borrar y vincular contactos: `companies.manage` (el administrador; el asesor no). Las notas
 * y tareas de una empresa van con `contacts.write`. `no-store`: son datos de negocio y no deben quedar en cachés.
 */
@Controller('companies')
export class CompaniesController {
  constructor(
    @Inject(CompaniesService) private readonly companies: CompaniesService,
    @Inject(NotesService) private readonly notes: NotesService,
  ) {}

  @RequirePermission('contacts.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listCompaniesQuerySchema)) q: ListCompaniesQuery) {
    return { ...(await this.companies.list(scopeOf(req), q)), access: { manage: has(req, 'companies.manage'), write: has(req, 'contacts.write') } };
  }

  @RequirePermission('companies.manage')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(createCompanySchema)) b: CreateCompanyDto) {
    return this.companies.create(scopeOf(req), b);
  }

  @RequirePermission('contacts.read')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  one(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.companies.get(scopeOf(req), id);
  }

  @RequirePermission('companies.manage')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateCompanySchema)) b: UpdateCompanyDto) {
    return this.companies.update(scopeOf(req), id, b);
  }

  /** Borrado lógico. */
  @RequirePermission('companies.manage')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Param('id', idParam) id: string) {
    return this.companies.remove(id);
  }

  @RequirePermission('contacts.read')
  @Get(':id/contacts')
  @Header('Cache-Control', 'no-store')
  contacts(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Query(new ZodValidationPipe(companyContactsQuerySchema)) q: CompanyContactsQuery) {
    return this.companies.contactsOf(scopeOf(req), id, q);
  }

  @RequirePermission('companies.manage')
  @Post(':id/contacts')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  link(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(linkContactsSchema)) b: LinkContactsDto) {
    return this.companies.link(scopeOf(req), id, b.contact_ids);
  }

  @RequirePermission('companies.manage')
  @Post(':id/contacts/remove')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  unlink(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(linkContactsSchema)) b: LinkContactsDto) {
    return this.companies.unlink(scopeOf(req), id, b.contact_ids);
  }

  @RequirePermission('contacts.read')
  @Get(':id/notes')
  @Header('Cache-Control', 'no-store')
  listNotes(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Query(new ZodValidationPipe(listNotesQuerySchema)) q: ListNotesQuery) {
    return this.notes.list(actorOf(req), { kind: 'company', id }, q);
  }

  @RequirePermission('contacts.write')
  @Post(':id/notes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  addNote(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(noteBodySchema)) b: NoteBodyDto) {
    return this.notes.create(actorOf(req), { kind: 'company', id }, b);
  }
}

/** Empresas de UN contacto, desde su ficha. */
@Controller('contacts/:contactId/companies')
export class ContactCompaniesController {
  constructor(@Inject(CompaniesService) private readonly companies: CompaniesService) {}

  @RequirePermission('companies.manage')
  @Post(':companyId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  link(@Req() req: AuthedRequest, @Param('contactId', idParam) contactId: string, @Param('companyId', idParam) companyId: string) {
    return this.companies.linkOne(scopeOf(req), contactId, companyId);
  }

  @RequirePermission('companies.manage')
  @Delete(':companyId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  unlink(@Req() req: AuthedRequest, @Param('contactId', idParam) contactId: string, @Param('companyId', idParam) companyId: string) {
    return this.companies.unlinkOne(scopeOf(req), contactId, companyId);
  }
}

/**
 * Notas internas (M3.6, ADR-48). Las de un contacto se ven con el alcance del contacto; el servicio decide quién edita (el autor) y quién borra (el autor o
 * `contacts.delete`). Nada de esto sale al cliente.
 */
@Controller()
export class NotesController {
  constructor(@Inject(NotesService) private readonly notes: NotesService) {}

  @RequirePermission('contacts.read')
  @Get('contacts/:contactId/notes')
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthedRequest, @Param('contactId', idParam) contactId: string, @Query(new ZodValidationPipe(listNotesQuerySchema)) q: ListNotesQuery) {
    return this.notes.list(actorOf(req), { kind: 'contact', id: contactId }, q);
  }

  @RequirePermission('contacts.write')
  @Post('contacts/:contactId/notes')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthedRequest, @Param('contactId', idParam) contactId: string, @Body(new ZodValidationPipe(noteBodySchema)) b: NoteBodyDto) {
    return this.notes.create(actorOf(req), { kind: 'contact', id: contactId }, b);
  }

  @RequirePermission('contacts.write')
  @Patch('notes/:id')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(noteBodySchema)) b: NoteBodyDto) {
    return this.notes.update(actorOf(req), id, b);
  }

  @RequirePermission('contacts.write')
  @Delete('notes/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.notes.remove(actorOf(req), id);
  }
}

/** Tareas (M3.6, ADR-48). Quién las ve y quién las cambia lo decide el servicio con el alcance de la persona. */
@Controller('tasks')
export class TasksController {
  constructor(@Inject(TasksService) private readonly tasks: TasksService) {}

  @RequirePermission('contacts.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listTasksQuerySchema)) q: ListTasksQuery) {
    return { ...(await this.tasks.list(scopeOf(req), q)), access: { view_all: has(req, 'contacts.view_all'), write: has(req, 'contacts.write') } };
  }

  @RequirePermission('contacts.write')
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: AuthedRequest, @Body(new ZodValidationPipe(createTaskSchema)) b: CreateTaskDto) {
    return this.tasks.create(scopeOf(req), b);
  }

  @RequirePermission('contacts.read')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  one(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.tasks.get(scopeOf(req), id);
  }

  @RequirePermission('contacts.write')
  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: AuthedRequest, @Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateTaskSchema)) b: UpdateTaskDto) {
    return this.tasks.update(scopeOf(req), id, b);
  }

  @RequirePermission('contacts.write')
  @Post(':id/complete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  complete(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.tasks.complete(scopeOf(req), id);
  }

  @RequirePermission('contacts.write')
  @Post(':id/reopen')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  reopen(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.tasks.reopen(scopeOf(req), id);
  }

  @RequirePermission('contacts.write')
  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.tasks.remove(scopeOf(req), id);
  }
}
