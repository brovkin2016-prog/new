import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WordstatClient } from './wordstat.client';

@Injectable()
export class SemanticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wordstat: WordstatClient,
  ) {}

  async core(projectId: string) {
    const core = await this.prisma.semanticCore.findUnique({
      where: { projectId },
      include: {
        clusters: {
          orderBy: { priority: 'desc' },
          include: { keywords: { include: { keyword: { select: { phrase: true, frequency: true } } } } },
        },
      },
    });
    return core ?? { projectId, clusters: [] };
  }

  /** Расширение ядра по маркерным запросам через Wordstat. Возвращает добавленные фразы. */
  async expand(projectId: string, markers: string[], regionCode?: number) {
    const added: string[] = [];
    for (const marker of markers) {
      const rows = await this.wordstat.expand(marker, regionCode);
      for (const r of rows) {
        try {
          await this.prisma.keyword.create({
            data: { projectId, phrase: r.phrase, regionCode, frequency: r.count },
          });
          added.push(r.phrase);
        } catch {
          /* уже существует — пропускаем */
        }
      }
    }
    return { added: added.length, phrases: added };
  }

  /** Пробелы: кластеры, где сайт не ранжируется, а у конкурентов есть (isGap). */
  gaps(projectId: string) {
    return this.prisma.cluster.findMany({
      where: { core: { projectId }, isGap: true },
      orderBy: { priority: 'desc' },
    });
  }
}
