import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { TaskRun, TaskType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TASKS_QUEUE, TaskJobData, redisConnection } from '../queue/queue.constants';
import { RunContext, TaskRunner } from '../common/runner';
import { PositionsRunner } from '../modules/positions/positions.runner';
import { AuditRunner } from '../modules/audit/audit.runner';
import { SemanticsRunner } from '../modules/semantics/semantics.runner';
import { CompetitorsRunner } from '../modules/competitors/competitors.runner';
import { ReportsService } from '../modules/reports/reports.service';

@Injectable()
export class ProcessingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProcessingService.name);
  private worker!: Worker;
  private readonly stopping = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly positions: PositionsRunner,
    private readonly audit: AuditRunner,
    private readonly semantics: SemanticsRunner,
    private readonly competitors: CompetitorsRunner,
    private readonly reports: ReportsService,
  ) {}

  onModuleInit() {
    const concurrency = parseInt(process.env.WORKER_CONCURRENCY ?? '4', 10);
    this.worker = new Worker<TaskJobData>(TASKS_QUEUE, (job) => this.process(job), {
      connection: redisConnection(),
      concurrency,
    });
    this.worker.on('failed', (job, err) => this.log.error(`Job ${job?.id} упал: ${err.message}`));
    this.log.log(`Воркер очереди запущен (concurrency=${concurrency})`);
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  requestStop(runId: string) {
    this.stopping.add(runId);
  }

  private runnerFor(type: TaskType): TaskRunner {
    return {
      positions: this.positions,
      audit: this.audit,
      semantics: this.semantics,
      competitors: this.competitors,
    }[type];
  }

  private async process(job: Job<TaskJobData>) {
    const { runId, type } = job.data;
    const run = await this.prisma.taskRun.findUnique({ where: { id: runId } });
    if (!run) return;
    if (this.stopping.has(runId)) {
      await this.finish(run, 'stopped');
      this.stopping.delete(runId);
      return;
    }

    await this.prisma.taskRun.update({
      where: { id: runId },
      data: { status: 'running', startedAt: new Date() },
    });

    const ctx: RunContext = {
      log: async (step, message, level = 'info') => {
        await this.prisma.runLog.create({ data: { runId, step, message, level } });
      },
      isStopping: () => this.stopping.has(runId),
    };

    try {
      const stats = await this.runnerFor(type).run(run, ctx);
      const finalStatus = this.stopping.has(runId) ? 'stopped' : 'success';
      await this.prisma.taskRun.update({
        where: { id: runId },
        data: { status: finalStatus, finishedAt: new Date(), stats: stats as any },
      });
      if (finalStatus === 'success') await this.reports.build(runId, type);
    } catch (e: any) {
      this.log.error(`Run ${runId} (${type}) ошибка: ${e.message}`);
      await this.finish(run, 'failed', e.message);
      throw e; // для ретраев BullMQ
    } finally {
      this.stopping.delete(runId);
    }
  }

  private async finish(run: TaskRun, status: 'failed' | 'stopped', error?: string) {
    await this.prisma.taskRun.update({
      where: { id: run.id },
      data: { status, finishedAt: new Date(), error },
    });
  }
}
