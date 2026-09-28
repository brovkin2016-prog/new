import { Injectable } from '@nestjs/common';
import { TaskRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RunContext, TaskRunner } from '../../common/runner';
import { YandexSearchClient } from '../positions/yandex-search.client';
import { ProviderRegistry } from './provider-registry.service';
import { normalizeDomain } from '../../common/url.util';
import { sleep } from '../../common/http.util';

interface CompetitorsParams {
  regionCode?: number;
  topCompetitors?: number;
}

@Injectable()
export class CompetitorsRunner implements TaskRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly yandex: YandexSearchClient,
    private readonly registry: ProviderRegistry,
  ) {}

  async run(run: TaskRun, ctx: RunContext): Promise<Record<string, unknown>> {
    const params = (run.params ?? {}) as CompetitorsParams;
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: run.taskId }, include: { project: true } });
    const lr = params.regionCode ?? 213;
    const ownDomain = normalizeDomain(task.project.domain);

    const core = await this.prisma.semanticCore.findUnique({
      where: { projectId: task.projectId },
      include: { clusters: true },
    });
    if (!core || !core.clusters.length) {
      await ctx.log('competitors', 'Нет семантического ядра — сначала запустите задачу semantics', 'warn');
      return { gaps: 0, competitors: 0 };
    }

    // Глобальный подсчёт конкурентов по кластерам
    const tally = new Map<string, number>();
    let gaps = 0;

    for (const cluster of core.clusters) {
      if (ctx.isStopping()) break;
      for (const d of (cluster.competitorUrls as string[]) ?? []) {
        const dom = normalizeDomain(d);
        if (dom && dom !== ownDomain) tally.set(dom, (tally.get(dom) ?? 0) + 1);
      }

      // Пробел: ранжируется ли наш домен по главному запросу кластера
      let isGap = false;
      try {
        const pos = await this.yandex.findPosition(cluster.name, lr, ownDomain, 30);
        isGap = pos.position == null;
      } catch {
        isGap = false;
      }
      if (isGap) gaps += 1;
      await this.prisma.cluster.update({ where: { id: cluster.id }, data: { isGap } });
      await sleep(300);
    }

    const topN = params.topCompetitors ?? 10;
    const topCompetitors = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([domain, clusters]) => ({ domain, clusters }));

    // Обогащение видимостью через провайдера (если сконфигурирован)
    const provider = this.registry.primary;
    if (provider) {
      await ctx.log('competitors', `Обогащение через ${provider.name}`);
      for (const c of topCompetitors) {
        if (ctx.isStopping()) break;
        const vis = await provider.domainVisibility(c.domain, lr);
        Object.assign(c, vis ?? {});
        await sleep(300);
      }
    }

    await this.prisma.report.upsert({
      where: { runId: run.id },
      update: { data: { topCompetitors, gaps }, type: 'competitors' },
      create: { runId: run.id, type: 'competitors', data: { topCompetitors, gaps } },
    });

    await ctx.log('competitors', `Конкурентов: ${topCompetitors.length}, пробелов: ${gaps}`);
    return { competitors: topCompetitors.length, gaps, provider: provider?.name ?? 'serp-only' };
  }
}
