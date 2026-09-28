import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  async summary(@CurrentUser() user: AuthUser) {
    const projects = await this.prisma.project.findMany({
      where: { userId: user.userId },
      select: { id: true },
    });
    const projectIds = projects.map((p) => p.id);
    if (!projectIds.length) {
      return { projects: 0, tasks: {}, runs: {}, avgDurationMs: null, recentRuns: [] };
    }

    const [tasksByStatus, runsByStatus, runs, recentRuns] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { projectId: { in: projectIds } },
        _count: true,
      }),
      this.prisma.taskRun.groupBy({
        by: ['status'],
        where: { task: { projectId: { in: projectIds } } },
        _count: true,
      }),
      this.prisma.taskRun.findMany({
        where: { task: { projectId: { in: projectIds } }, status: 'success', startedAt: { not: null }, finishedAt: { not: null } },
        select: { startedAt: true, finishedAt: true },
        take: 200,
        orderBy: { finishedAt: 'desc' },
      }),
      this.prisma.taskRun.findMany({
        where: { task: { projectId: { in: projectIds } } },
        include: { task: { select: { name: true, type: true } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const durations = runs.map((r) => r.finishedAt!.getTime() - r.startedAt!.getTime());
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

    return {
      projects: projectIds.length,
      tasks: Object.fromEntries(tasksByStatus.map((t) => [t.status, t._count])),
      runs: Object.fromEntries(runsByStatus.map((r) => [r.status, r._count])),
      errors: runsByStatus.find((r) => r.status === 'failed')?._count ?? 0,
      avgDurationMs: avg,
      recentRuns,
    };
  }
}
