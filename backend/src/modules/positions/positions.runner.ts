import { Injectable } from '@nestjs/common';
import { TaskRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RunContext, TaskRunner } from '../../common/runner';
import { sleep } from '../../common/http.util';
import { YandexSearchClient } from './yandex-search.client';

interface PositionsParams {
  keywordIds?: string[];
  regionCodes?: number[];
  depth?: number;
  device?: 'desktop' | 'mobile';
}

@Injectable()
export class PositionsRunner implements TaskRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly yandex: YandexSearchClient,
  ) {}

  async run(run: TaskRun, ctx: RunContext): Promise<Record<string, unknown>> {
    const params = (run.params ?? {}) as PositionsParams;
    const depth = params.depth ?? 30;
    const device = params.device ?? 'desktop';

    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id: run.taskId },
      include: { project: true },
    });
    const domain = task.project.domain;

    const keywords = await this.prisma.keyword.findMany({
      where: params.keywordIds?.length
        ? { id: { in: params.keywordIds } }
        : { projectId: task.projectId },
    });

    const regionCodes =
      params.regionCodes?.length
        ? params.regionCodes
        : (await this.prisma.projectRegion.findMany({ where: { projectId: task.projectId } })).map(
            (r) => r.regionCode,
          );
    const regions = regionCodes.length ? regionCodes : [213]; // Москва по умолчанию

    let checked = 0;
    let found = 0;
    let errors = 0;

    for (const kw of keywords) {
      if (ctx.isStopping()) break;
      for (const lr of regions) {
        if (ctx.isStopping()) break;
        try {
          const r = await this.yandex.findPosition(kw.phrase, lr, domain, depth, device);
          await this.prisma.positionResult.create({
            data: {
              runId: run.id,
              keywordId: kw.id,
              regionCode: lr,
              position: r.position,
              url: r.url,
              inTop30: r.inTop30,
            },
          });
          checked += 1;
          if (r.position) found += 1;
        } catch (e: any) {
          errors += 1;
          await ctx.log('positions', `"${kw.phrase}" lr=${lr}: ${e.message}`, 'warn');
        }
        await sleep(300); // мягкий rate-limit к API
      }
    }

    await ctx.log('positions', `Проверено ${checked}, найдено ${found}, ошибок ${errors}`);
    return { checked, found, errors, keywords: keywords.length, regions: regions.length };
  }
}
