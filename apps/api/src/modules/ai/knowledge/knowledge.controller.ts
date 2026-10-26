import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../../errors';
import { ZodValidationPipe } from '../../../http';
import { RequirePermission } from '../../../rbac';
import { KnowledgeService } from './knowledge.service';
import { MAX_DOCUMENT_BYTES } from './document-parser';

const idParam = new ZodValidationPipe(z.uuid());

const listQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().max(200).optional() });
const updateSchema = z.strictObject({ active: z.boolean().optional(), name: z.string().trim().min(1).max(200).optional() }).refine((b) => b.active !== undefined || b.name !== undefined, 'No hay nada que cambiar');
const searchSchema = z.strictObject({ query: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(10).optional() });

/** Lee el cuerpo hasta `limit` bytes DESPUÉS de la autenticación y los permisos (no en un middleware): quien no tiene sesión no puede hacer que el servidor reciba decenas de megas. 413 sin guardar el resto. */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): AppError => new AppError(413, 'DOCUMENT_TOO_LARGE', `El documento pesa demasiado: el máximo es ${Math.floor(limit / (1024 * 1024))} MB`);
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
      if (!over) reject(new AppError(400, 'DOCUMENT_UPLOAD_FAILED', 'La subida del archivo se interrumpió'));
    });
  });
}

/** El nombre que manda el navegador en `X-Filename` (codificado con `encodeURIComponent`). */
function filenameOf(req: Request): string | null {
  const raw = req.headers['x-filename'];
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 600) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Biblioteca de conocimiento de la empresa (M8.2, ADR-53; F16): documentos para que los agentes respondan con datos de la empresa. Solo quien administra el conocimiento (`knowledge.manage`). `no-store`.
 * La subida es el archivo tal cual (cuerpo crudo) con su nombre en `X-Filename`.
 */
@RequirePermission('knowledge.manage')
@Controller('knowledge')
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  @Get('documents')
  @Header('Cache-Control', 'no-store')
  list(@Query(new ZodValidationPipe(listQuerySchema)) q: z.infer<typeof listQuerySchema>) {
    return this.knowledge.list(q);
  }

  @Post('documents')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async upload(@Req() req: Request) {
    const bytes = await readBody(req, MAX_DOCUMENT_BYTES);
    return this.knowledge.upload({ bytes, filename: filenameOf(req) });
  }

  @Patch('documents/:id')
  @Header('Cache-Control', 'no-store')
  update(@Param('id', idParam) id: string, @Body(new ZodValidationPipe(updateSchema)) b: z.infer<typeof updateSchema>) {
    return this.knowledge.update(id, b);
  }

  @Post('documents/:id/reprocess')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  reprocess(@Param('id', idParam) id: string) {
    return this.knowledge.reprocess(id);
  }

  @Delete('documents/:id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  remove(@Param('id', idParam) id: string) {
    return this.knowledge.remove(id);
  }

  /** «Probar la búsqueda»: los fragmentos de la biblioteca más parecidos a una pregunta (cuesta créditos, apenas uno). */
  @Post('search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  search(@Body(new ZodValidationPipe(searchSchema)) b: z.infer<typeof searchSchema>) {
    return this.knowledge.search({ query: b.query, limit: b.limit, kind: 'test' });
  }
}
