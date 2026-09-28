import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  pages(runId: string) {
    return this.prisma.auditPage.findMany({ where: { runId }, orderBy: { depth: 'asc' } });
  }

  brokenLinks(runId: string) {
    return this.prisma.brokenLink.findMany({ where: { runId } });
  }

  async issues(runId: string) {
    const pages = await this.prisma.auditPage.findMany({ where: { runId } });
    const report = await this.prisma.report.findUnique({ where: { runId } });
    return {
      technical: (report?.data as any)?.technicalIssues ?? [],
      pages: pages
        .filter((p) => (p.issues as string[]).length)
        .map((p) => ({ url: p.url, issues: p.issues })),
    };
  }
}
