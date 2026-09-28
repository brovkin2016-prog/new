import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CompetitorsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Конкуренты по кластеру (competitorUrls) или сводно по проекту. */
  async list(projectId: string, clusterId?: string) {
    if (clusterId) {
      const cluster = await this.prisma.cluster.findFirst({
        where: { id: clusterId, core: { projectId } },
      });
      return { clusterId, competitors: (cluster?.competitorUrls as string[]) ?? [] };
    }
    // сводно: последний отчёт competitors
    const run = await this.prisma.taskRun.findFirst({
      where: { task: { projectId, type: 'competitors' }, status: 'success' },
      orderBy: { finishedAt: 'desc' },
      include: { report: true },
    });
    return (run?.report?.data as any) ?? { topCompetitors: [], gaps: 0 };
  }
}
