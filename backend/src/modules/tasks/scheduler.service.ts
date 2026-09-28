import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueProducer } from '../../queue/queue.producer';

/**
 * Планировщик cron-задач. На каждую активную задачу с cron регистрирует CronJob,
 * который ставит запуск в очередь. Нагрузка распределяется во времени самим cron.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly log = new Logger(SchedulerService.name);
  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly producer: QueueProducer,
  ) {}

  async onModuleInit() {
    const tasks = await this.prisma.task.findMany({
      where: { status: 'active', cron: { not: null } },
    });
    for (const t of tasks) this.register(t.id, t.cron!);
    this.log.log(`Зарегистрировано cron-задач: ${tasks.length}`);
  }

  private jobName(taskId: string) {
    return `task:${taskId}`;
  }

  register(taskId: string, cron: string) {
    this.unregister(taskId);
    try {
      const job = new CronJob(cron, async () => {
        const task = await this.prisma.task.findUnique({ where: { id: taskId } });
        if (!task || task.status !== 'active') return;
        const run = await this.prisma.taskRun.create({
          data: { taskId, status: 'queued', params: task.params as any },
        });
        await this.producer.enqueue({ runId: run.id, taskId, type: task.type });
      });
      this.registry.addCronJob(this.jobName(taskId), job as any);
      job.start();
    } catch (e: any) {
      this.log.warn(`Некорректный cron "${cron}" для ${taskId}: ${e.message}`);
    }
  }

  unregister(taskId: string) {
    try {
      this.registry.deleteCronJob(this.jobName(taskId));
    } catch {
      /* не был зарегистрирован */
    }
  }

  sync(taskId: string, cron: string | null) {
    if (cron) this.register(taskId, cron);
    else this.unregister(taskId);
  }
}
