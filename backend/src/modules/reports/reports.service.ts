import { Injectable } from '@nestjs/common';
import { TaskType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Собрать агрегированный отчёт по завершённому запуску. */
  async build(runId: string, type: TaskType) {
    const data =
      type === 'positions'
        ? await this.positionsReport(runId)
        : type === 'audit'
          ? await this.auditReport(runId)
          : type === 'semantics'
            ? await this.semanticsReport(runId)
            : null; // competitors собирается в раннере

    if (!data) return;
    await this.prisma.report.upsert({
      where: { runId },
      update: { data, type },
      create: { runId, type, data },
    });
  }

  private async positionsReport(runId: string) {
    const rows = await this.prisma.positionResult.findMany({
      where: { runId },
      include: { keyword: { select: { phrase: true } } },
    });
    const found = rows.filter((r) => r.position != null);
    const avg = found.length ? found.reduce((s, r) => s + (r.position ?? 0), 0) / found.length : null;
    return {
      total: rows.length,
      top3: rows.filter((r) => (r.position ?? 99) <= 3).length,
      top10: rows.filter((r) => (r.position ?? 99) <= 10).length,
      top30: rows.filter((r) => r.inTop30).length,
      notFound: rows.length - found.length,
      avgPosition: avg ? Math.round(avg * 10) / 10 : null,
      items: rows.map((r) => ({ phrase: r.keyword.phrase, region: r.regionCode, position: r.position, url: r.url })),
    };
  }

  private async auditReport(runId: string) {
    const [pages, broken, run] = await Promise.all([
      this.prisma.auditPage.findMany({ where: { runId } }),
      this.prisma.brokenLink.findMany({ where: { runId } }),
      this.prisma.taskRun.findUnique({ where: { id: runId } }),
    ]);
    const withSpeed = pages.filter((p) => p.lcpMs != null);
    const avgLcp = withSpeed.length ? Math.round(withSpeed.reduce((s, p) => s + (p.lcpMs ?? 0), 0) / withSpeed.length) : null;
    return {
      pages: pages.length,
      brokenLinks: broken.length,
      pagesWithIssues: pages.filter((p) => (p.issues as string[]).length).length,
      avgLcpMs: avgLcp,
      technicalIssues: (run?.stats as any)?.technicalIssues ?? [],
      statusCodes: this.tally(pages.map((p) => String(p.statusCode))),
    };
  }

  private async semanticsReport(runId: string) {
    const run = await this.prisma.taskRun.findUniqueOrThrow({ where: { id: runId }, include: { task: true } });
    const core = await this.prisma.semanticCore.findUnique({
      where: { projectId: run.task.projectId },
      include: { clusters: true },
    });
    const clusters = core?.clusters ?? [];
    return {
      clusters: clusters.length,
      byIntent: this.tally(clusters.map((c) => c.intent)),
      totalVolume: clusters.reduce((s, c) => s + c.volume, 0),
      totalPotential: clusters.reduce((s, c) => s + c.potentialTraffic, 0),
      gaps: clusters.filter((c) => c.isGap).length,
    };
  }

  private tally(items: string[]): Record<string, number> {
    const m: Record<string, number> = {};
    for (const i of items) m[i] = (m[i] ?? 0) + 1;
    return m;
  }

  get(runId: string) {
    return this.prisma.report.findUnique({ where: { runId } });
  }
}
