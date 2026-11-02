import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations';
import { RealtimeModule } from '../realtime';
import { TaskDueNoticesJob } from './task-due.job';
import { TaskNoticesService } from './task-notices.service';

/** Avisos de tareas (F2, ADR-58): «te asignaron» y «vence». Lo llaman los sitios que crean tareas; la tarea periódica emite los de vencimiento. */
@Module({ imports: [OrganizationsModule, RealtimeModule], providers: [TaskNoticesService, TaskDueNoticesJob], exports: [TaskNoticesService, TaskDueNoticesJob] })
export class TaskNoticesModule {}
