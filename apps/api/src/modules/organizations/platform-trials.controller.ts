import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { UnauthorizedError } from '../../errors';
import { PlatformOnly, ZodValidationPipe } from '../../http';
import type { AuthedRequest } from '../../http/access.guard';
import { RequirePermission } from '../../rbac';
import { listTrialsQuerySchema, trialIdParamSchema, type ListTrialsQuery } from './trials.dto';
import { TrialsService } from './trials.service';

/** Pestaña «Pruebas» de la consola de plataforma (Súper Admin). */
@PlatformOnly()
@RequirePermission('platform.trials.manage')
@Controller('platform/trials')
export class PlatformTrialsController {
  constructor(@Inject(TrialsService) private readonly trials: TrialsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listTrialsQuerySchema)) q: ListTrialsQuery) {
    return this.trials.list({ extension: q.extension, state: q.state, limit: q.limit, cursor: q.cursor });
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id', new ZodValidationPipe(trialIdParamSchema)) id: string, @Req() req: AuthedRequest) {
    return this.trials.approve({ trialId: id, actorUserId: this.actor(req) });
  }

  @Post(':id/deny')
  @HttpCode(200)
  deny(@Param('id', new ZodValidationPipe(trialIdParamSchema)) id: string, @Req() req: AuthedRequest) {
    return this.trials.deny({ trialId: id, actorUserId: this.actor(req) });
  }

  private actor(req: AuthedRequest): string {
    if (req.principal?.kind !== 'platform') throw new UnauthorizedError();
    return req.principal.userId;
  }
}
