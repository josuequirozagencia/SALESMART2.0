import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../../errors';
import { ZodValidationPipe } from '../../../http';
import { RequirePermission } from '../../../rbac';
import { AgentTestService } from './agent-test.service';
import { createAgentSchema, previewSchema, setChannelsSchema, setDocumentsSchema, testTurnSchema, updateAgentSchema, type CreateAgentDto, type PreviewDto, type SetChannelsDto, type SetDocumentsDto, type TestTurnDto, type UpdateAgentDto } from './agents.dto';
import { AgentsService, MAX_PHOTO_BYTES } from './agents.service';

const idParam = new ZodValidationPipe(z.uuid());

/** Lee el cuerpo hasta `limit` bytes DESPUÉS de la autenticación y los permisos: quien no tiene sesión no puede hacer que el servidor reciba megas. 413 sin guardar el resto. */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): AppError => new AppError(413, 'AGENT_PHOTO_TOO_LARGE', `La foto pesa demasiado: el máximo es ${Math.floor(limit / (1024 * 1024))} MB`);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return reject(tooLarge());
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        req.res?.setHeader('Connection', 'close');
        req.resume();
        return reject(tooLarge());
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!over) reject(new AppError(400, 'AGENT_PHOTO_UPLOAD_FAILED', 'La subida de la foto se interrumpió'));
    });
  });
}

/**
 * Agentes de IA de la empresa (M8.3, ADR-20/53; F16): galería, ajustes, foto, documentos, conexiones y vista previa de las instrucciones. Solo quien administra agentes (`agents.manage`). `no-store`.
 * Aún no responden mensajes (M8.5): aquí solo se configuran.
 */
@RequirePermission('agents.manage')
@Controller('agents')
export class AgentsController {
  constructor(
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(AgentTestService) private readonly tests: AgentTestService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list() {
    return this.agents.list();
  }

  /** Modelos, paleta, variables, conexiones (con su agente), colas y biblioteca: lo que necesita el formulario. */
  @Get('options')
  @Header('Cache-Control', 'no-store')
  options() {
    return this.agents.options();
  }

  /** Cómo quedarían las instrucciones con un contacto real o uno de ejemplo; no gasta créditos. */
  @Post('preview')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  preview(@Body(new ZodValidationPipe(previewSchema)) b: PreviewDto) {
    return this.agents.preview(b);
  }

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@Body(new ZodValidationPipe(createAgentSchema)) b: CreateAgentDto) {
    return this.agents.create(b);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@Param('id', idParam) id: string) {
    return this.agents.get(id);
  }

  @Patch(':id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateAgentSchema)) b: UpdateAgentDto) {
    return this.agents.update(id, b);
  }

  @Delete(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Param('id', idParam) id: string) {
    return this.agents.remove(id);
  }

  @Put(':id/documents')
  @Header('Cache-Control', 'no-store')
  setDocuments(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(setDocumentsSchema)) b: SetDocumentsDto) {
    return this.agents.setDocuments(id, b.document_ids);
  }

  @Put(':id/channels')
  @Header('Cache-Control', 'no-store')
  setChannels(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(setChannelsSchema)) b: SetChannelsDto) {
    return this.agents.setChannels(id, b.channel_ids);
  }

  /** La foto es el archivo tal cual (JPEG, PNG o WebP de hasta 2 MB). */
  @Put(':id/photo')
  @Header('Cache-Control', 'no-store')
  async setPhoto(@Param('id', idParam) id: string, @Req() req: Request) {
    return this.agents.setPhoto(id, await readBody(req, MAX_PHOTO_BYTES));
  }

  /**
   * Simulador de prueba (M8.4): un turno de conversación con las instrucciones y los documentos guardados del agente. **No envía mensajes ni crea contactos.** Cuesta créditos de «prueba» y tiene un
   * tope diario por empresa. Permiso propio (`agents.test`).
   */
  @RequirePermission('agents.test')
  @Post(':id/test')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  test(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(testTurnSchema)) b: TestTurnDto) {
    return this.tests.turn(id, b);
  }

  @Delete(':id/photo')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  removePhoto(@Param('id', idParam) id: string) {
    return this.agents.removePhoto(id);
  }
}
