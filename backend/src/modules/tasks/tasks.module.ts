import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { SchedulerService } from './scheduler.service';
import { ProcessingModule } from '../../processing/processing.module';

@Module({
  imports: [ProcessingModule],
  controllers: [TasksController],
  providers: [TasksService, SchedulerService],
  exports: [TasksService, SchedulerService],
})
export class TasksModule {}
