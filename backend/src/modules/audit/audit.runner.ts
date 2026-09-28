import { Injectable } from '@nestjs/common';
import { TaskRun } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RunContext, TaskRunner } from '../../common/runner';
import { CrawlerService } from './crawler.service';
import { PageSpeedClient } from './pagespeed.client';

interface AuditParams {
  startUrl?: string;
  maxPages?: number;
  maxDepth?: number;
  measureSpeed?: boolean;
  speedTopN?: number;
  device?: 'desktop' | 'mobile';
  checkExternal?: boolean;
}

@Injectable()
export class AuditRunner implements TaskRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crawler: CrawlerService,
    private readonly pagespeed: PageSpeedClient,
  ) {}

  async run(run: TaskRun, ctx: RunContext): Promise<Record<string, unknown>> {
    const params = (run.params ?? {}) as AuditParams;
    const task = await this.prisma.task.findUniqueOrThrow({
      where: { id: run.taskId },
      include: { project: true },
    });
    const domain = task.project.domain;
    const startUrl = params.startUrl ?? task.project.targetUrl ?? `https://${domain}/`;

    await ctx.log('audit', `Краул ${startUrl} (макс ${params.maxPages ?? 'default'} стр.)`);
    const result = await this.crawler.crawl(
      domain,
      startUrl,
      {
        maxPages: params.maxPages,
        maxDepth: params.maxDepth,
        checkExternal: params.checkExternal,
      },
      () => ctx.isStopping(),
    );

    // Скорость только по реально посещённым (успешным) страницам, топ-N.
    const speedTopN = params.speedTopN ?? 5;
    const speedByUrl = new Map<string, Awaited<ReturnType<PageSpeedClient['measure']>>>();
    if ((params.measureSpeed ?? true) && this.pagespeed.enabled) {
      const targets = result.pages.filter((p) => p.statusCode >= 200 && p.statusCode < 300).slice(0, speedTopN);
      for (const p of targets) {
        if (ctx.isStopping()) break;
        speedByUrl.set(p.url, await this.pagespeed.measure(p.url, params.device ?? 'desktop'));
      }
      await ctx.log('audit', `Скорость измерена для ${speedByUrl.size} страниц`);
    }

    // Персист страниц
    for (const p of result.pages) {
      const s = speedByUrl.get(p.url) ?? {};
      await this.prisma.auditPage.create({
        data: {
          runId: run.id,
          url: p.url,
          statusCode: p.statusCode,
          responseMs: p.responseMs ?? s.serverResponseMs,
          lcpMs: s.lcpMs,
          fcpMs: s.fcpMs,
          ttiMs: s.ttiMs,
          title: p.title,
          description: p.description,
          headings: p.headings,
          issues: p.issues,
          depth: p.depth,
        },
      });
    }
    // Битые ссылки
    if (result.brokenLinks.length) {
      await this.prisma.brokenLink.createMany({
        data: result.brokenLinks.map((b) => ({ runId: run.id, ...b })),
      });
    }

    const stats = {
      pages: result.pages.length,
      brokenLinks: result.brokenLinks.length,
      technicalIssues: result.technical,
      pagesWithIssues: result.pages.filter((p) => p.issues.length).length,
    };
    await ctx.log('audit', `Готово: ${stats.pages} стр., ${stats.brokenLinks} битых ссылок`);
    return stats;
  }
}
