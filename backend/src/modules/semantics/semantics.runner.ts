import { Injectable } from '@nestjs/common';
import { TaskRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RunContext, TaskRunner } from '../../common/runner';
import { WordstatClient } from './wordstat.client';
import { ClusteringService, KwInput } from './clustering.service';

interface SemanticsParams {
  regionCode?: number;
  urlThreshold?: number;
}

@Injectable()
export class SemanticsRunner implements TaskRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wordstat: WordstatClient,
    private readonly clustering: ClusteringService,
  ) {}

  async run(run: TaskRun, ctx: RunContext): Promise<Record<string, unknown>> {
    const params = (run.params ?? {}) as SemanticsParams;
    const task = await this.prisma.task.findUniqueOrThrow({ where: { id: run.taskId } });
    const lr = params.regionCode ?? 213;

    const keywords = await this.prisma.keyword.findMany({ where: { projectId: task.projectId } });
    if (!keywords.length) {
      await ctx.log('semantics', 'Нет ключей для кластеризации', 'warn');
      return { clusters: 0, keywords: 0 };
    }

    // Дозагрузка частотности
    const inputs: KwInput[] = [];
    for (const kw of keywords) {
      let freq = kw.frequency ?? null;
      if (freq == null && this.wordstat.enabled) {
        freq = await this.wordstat.frequency(kw.phrase, lr);
        if (freq != null) await this.prisma.keyword.update({ where: { id: kw.id }, data: { frequency: freq } });
      }
      inputs.push({ id: kw.id, phrase: kw.phrase, frequency: freq ?? 0 });
    }

    await ctx.log('semantics', `Кластеризация ${inputs.length} фраз (lr=${lr})`);
    const clusters = await this.clustering.cluster(inputs, lr, params.urlThreshold ?? 3);

    // Пересоздать ядро
    const core = await this.prisma.semanticCore.upsert({
      where: { projectId: task.projectId },
      update: {},
      create: { projectId: task.projectId },
    });
    await this.prisma.cluster.deleteMany({ where: { coreId: core.id } });

    for (const c of clusters) {
      await this.prisma.cluster.create({
        data: {
          coreId: core.id,
          name: c.name,
          intent: c.intent,
          volume: c.volume,
          difficulty: c.difficulty,
          commercialValue: c.commercialValue,
          potentialTraffic: c.potentialTraffic,
          priority: c.priority,
          competitorUrls: c.competitorUrls,
          keywords: { create: c.keywordIds.map((kid) => ({ keywordId: kid })) },
        },
      });
    }

    await ctx.log('semantics', `Создано кластеров: ${clusters.length}`);
    return { clusters: clusters.length, keywords: inputs.length };
  }
}
