import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Database } from '../db';
import { Public } from '../http';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Liveness: el proceso responde. No toca la base de datos. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: la base de datos responde. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await this.db.ping();
      return { status: 'ok' };
    } catch {
      throw new HttpException({ status: 'unavailable' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
