import { Module } from '@nestjs/common';
import { ConnectionQueueService } from './connection-queue.service';

/** Reglas compartidas del departamento de una conexión (v7, ADR-65). */
@Module({ providers: [ConnectionQueueService], exports: [ConnectionQueueService] })
export class ConnectionQueueModule {}
