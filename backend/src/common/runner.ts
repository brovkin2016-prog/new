import { TaskRun } from '@prisma/client';

/** Контекст выполнения запуска: логирование по шагам и кооперативная остановка. */
export interface RunContext {
  log(step: string, message: string, level?: 'info' | 'warn' | 'error'): Promise<void>;
  isStopping(): boolean;
}

/** Доменный исполнитель задачи. Возвращает агрегированную статистику (stats JSONB). */
export interface TaskRunner {
  run(run: TaskRun, ctx: RunContext): Promise<Record<string, unknown>>;
}
