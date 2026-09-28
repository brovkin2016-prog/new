import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator';
import { TaskType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { TasksService } from './tasks.service';

class CreateTaskDto {
  @IsEnum(TaskType) type: TaskType;
  @IsString() name: string;
  @IsOptional() @IsObject() params?: Record<string, unknown>;
  @IsOptional() @IsString() cron?: string;
}
class UpdateTaskDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsObject() params?: Record<string, unknown>;
  @IsOptional() @IsString() cron?: string;
}

@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Get('projects/:projectId/tasks')
  list(@Param('projectId') projectId: string) {
    return this.service.list(projectId);
  }
  @Post('projects/:projectId/tasks')
  create(@Param('projectId') projectId: string, @Body() dto: CreateTaskDto) {
    return this.service.create(projectId, dto);
  }
  @Get('tasks/:id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }
  @Patch('tasks/:id')
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.service.update(id, dto);
  }
  @Delete('tasks/:id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
  @Post('tasks/:id/run')
  run(@Param('id') id: string) {
    return this.service.run(id);
  }
  @Post('tasks/:id/pause')
  pause(@Param('id') id: string) {
    return this.service.pause(id);
  }
  @Post('tasks/:id/resume')
  resume(@Param('id') id: string) {
    return this.service.resume(id);
  }
  @Post('tasks/:id/stop')
  stop(@Param('id') id: string) {
    return this.service.stop(id);
  }
  @Get('tasks/:id/runs')
  runs(@Param('id') id: string) {
    return this.service.runs(id);
  }
  @Post('tasks/:id/runs/:runId/rerun')
  rerun(@Param('id') id: string, @Param('runId') runId: string) {
    return this.service.rerun(id, runId);
  }
}
