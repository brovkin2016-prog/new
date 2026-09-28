import { BadRequestException, Injectable } from '@nestjs/common';
import { TaskType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueProducer } from '../../queue/queue.producer';
import { SchedulerService } from './scheduler.service';
import { ProcessingService } from '../../processing/processing.service';

interface CreateTaskDto {
  type: TaskType;
  name: string;
  params?: Record<string, unknown>;
  cron?: string;
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: QueueProducer,
    private readonly scheduler: SchedulerService,
    private readonly processing: ProcessingService,
  ) {}

  list(projectId: string) {
    return this.prisma.task.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { runs: true } } },
    });
  }

  get(id: string) {
    return this.prisma.task.findUniqueOrThrow({ where: { id } });
  }

  async create(projectId: string, dto: CreateTaskDto) {
    const task = await this.prisma.task.create({
      data: { projectId, type: dto.type, name: dto.name, params: (dto.params ?? {}) as any, cron: dto.cron },
    });
    if (task.cron) this.scheduler.register(task.id, task.cron);
    return task;
  }

  async update(id: string, dto: Partial<CreateTaskDto>) {
    const task = await this.prisma.task.update({ where: { id }, data: dto as any });
    this.scheduler.sync(task.id, task.status === 'active' ? task.cron : null);
    return task;
  }

  async remove(id: string) {
    this.scheduler.unregister(id);
    return this.prisma.task.delete({ where: { id } });
  }

  /** Запуск: создаём TaskRun и ставим в очередь. */
  async run(id: string) {
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id } });
    if (task.status === 'paused') throw new BadRequestException('Задача на паузе');
    const run = await this.prisma.taskRun.create({
      data: { taskId: id, status: 'queued', params: task.params ?? {} },
    });
    await this.producer.enqueue({ runId: run.id, taskId: id, type: task.type });
    return run;
  }

  async pause(id: string) {
    this.scheduler.unregister(id);
    return this.prisma.task.update({ where: { id }, data: { status: 'paused' } });
  }

  async resume(id: string) {
    const task = await this.prisma.task.update({ where: { id }, data: { status: 'active' } });
    if (task.cron) this.scheduler.register(task.id, task.cron);
    return task;
  }

  /** Остановка активного запуска (кооперативно). */
  async stop(id: string) {
    const run = await this.prisma.taskRun.findFirst({
      where: { taskId: id, status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (run) this.processing.requestStop(run.id);
    return { stopped: run?.id ?? null };
  }

  runs(taskId: string) {
    return this.prisma.taskRun.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' } });
  }

  /** Повтор запуска по шаблону: тот же снимок параметров. */
  async rerun(taskId: string, runId: string) {
    const prev = await this.prisma.taskRun.findUniqueOrThrow({ where: { id: runId } });
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    const run = await this.prisma.taskRun.create({
      data: { taskId, status: 'queued', params: prev.params as any },
    });
    await this.producer.enqueue({ runId: run.id, taskId, type: task.type });
    return run;
  }
}
