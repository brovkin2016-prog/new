import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { TASKS_QUEUE, TaskJobData, redisConnection } from './queue.constants';

@Injectable()
export class QueueProducer implements OnModuleDestroy {
  private readonly queue = new Queue(TASKS_QUEUE, { connection: redisConnection() });

  /** Поставить запуск задачи в очередь. */
  async enqueue(data: TaskJobData): Promise<string> {
    const job = await this.queue.add(data.type, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
    return job.id as string;
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
