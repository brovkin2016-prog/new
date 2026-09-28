import { ConnectionOptions } from 'bullmq';

export const TASKS_QUEUE = 'pf-tasks';

export function redisConnection(): ConnectionOptions {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  };
}

export interface TaskJobData {
  runId: string;
  taskId: string;
  type: 'positions' | 'audit' | 'semantics' | 'competitors';
}
