import { Body, Controller, Get, Header, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { readUploadBody, uploadFilenameOf, ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { MAX_UPLOAD_BYTES } from '../attachments';
import { folderSchema, listLibraryQuerySchema, updateAssetSchema, uploadAssetQuerySchema, type FolderDto, type ListLibraryQuery, type UpdateAssetDto, type UploadAssetQuery } from './library.dto';
import { LibraryService, type LibraryAccess } from './library.service';

const idParam = new ZodValidationPipe(z.uuid());
/** Qué puede hacer quien consulta sale de sus permisos VERIFICADOS (nunca de la petición): sin `library.manage` es un asesor y solo ve lo marcado para asesores. */
const accessOf = (req: AuthedRequest): LibraryAccess => ({ manage: req.principal?.permissions?.has('library.manage') === true });

/**
 * Biblioteca de archivos de la empresa (V21, ADR-75). Tenant: la organización sale del contexto verificado. Ver y pedir una URL firmada: `library.read` (el asesor solo ve lo marcado para asesores);
 * subir, mover, marcar usos y archivar: `library.manage`. Lo de otra empresa responde 404 igual que lo inexistente. `no-store`.
 */
@Controller('library')
export class LibraryController {
  constructor(@Inject(LibraryService) private readonly library: LibraryService) {}

  @RequirePermission('library.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(listLibraryQuerySchema)) q: ListLibraryQuery) {
    const access = accessOf(req);
    return { ...(await this.library.list(access, q)), access: { manage: access.manage } };
  }

  @RequirePermission('library.manage')
  @Get('usage')
  @Header('Cache-Control', 'no-store')
  usage() {
    return this.library.usage();
  }

  /** El archivo va como cuerpo (con su `Content-Type` y `X-Filename`; se lee DESPUÉS de autenticar, con tope de tamaño). */
  @RequirePermission('library.manage')
  @Post('assets')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async upload(@Req() req: AuthedRequest, @Query(new ZodValidationPipe(uploadAssetQuerySchema)) q: UploadAssetQuery) {
    const bytes = await readUploadBody(req, MAX_UPLOAD_BYTES);
    return this.library.upload({ bytes, contentType: req.headers['content-type'], filename: uploadFilenameOf(req) }, q);
  }

  @RequirePermission('library.manage')
  @Patch('assets/:id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateAssetSchema)) b: UpdateAssetDto) {
    return this.library.update(id, b);
  }

  @RequirePermission('library.manage')
  @Post('assets/:id/archive')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  archive(@Param('id', idParam) id: string) {
    return this.library.archive(id);
  }

  @RequirePermission('library.read')
  @Get('assets/:id/url')
  @Header('Cache-Control', 'no-store')
  url(@Req() req: AuthedRequest, @Param('id', idParam) id: string) {
    return this.library.assetUrl(accessOf(req), id);
  }

  @RequirePermission('library.manage')
  @Post('folders')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  createFolder(@Body(new ZodValidationPipe(folderSchema)) b: FolderDto) {
    return this.library.createFolder(b);
  }

  @RequirePermission('library.manage')
  @Patch('folders/:id')
  @Header('Cache-Control', 'no-store')
  renameFolder(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(folderSchema)) b: FolderDto) {
    return this.library.renameFolder(id, b);
  }

  @RequirePermission('library.manage')
  @Post('folders/:id/archive')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  archiveFolder(@Param('id', idParam) id: string) {
    return this.library.archiveFolder(id);
  }
}
