import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { AppConfig } from '../config';
import type { AppLogger } from '../logger';
import { APP_CONFIG, APP_LOGGER } from '../tokens';
import { Database } from './database';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(Database) private readonly db: Database) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: Database,
      useFactory: (cfg: AppConfig, log: AppLogger) => Database.create(cfg, log),
      inject: [APP_CONFIG, APP_LOGGER],
    },
    DatabaseLifecycle,
  ],
  exports: [Database],
})
export class DbModule {}
