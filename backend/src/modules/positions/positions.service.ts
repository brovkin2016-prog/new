import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** История позиций проекта с фильтрами. */
  async history(projectId: string, q: { keywordId?: string; regionCode?: number; from?: string; to?: string }) {
    return this.prisma.positionResult.findMany({
      where: {
        keyword: { projectId },
        keywordId: q.keywordId,
        regionCode: q.regionCode,
        checkedAt: {
          gte: q.from ? new Date(q.from) : undefined,
          lte: q.to ? new Date(q.to) : undefined,
        },
      },
      include: { keyword: { select: { phrase: true } } },
      orderBy: { checkedAt: 'desc' },
      take: 1000,
    });
  }

  /** Последний срез позиций по каждому ключу/региону. */
  async latest(projectId: string) {
    const rows = await this.prisma.positionResult.findMany({
      where: { keyword: { projectId } },
      include: { keyword: { select: { phrase: true } } },
      orderBy: { checkedAt: 'desc' },
      take: 5000,
    });
    const seen = new Set<string>();
    const out: typeof rows = [];
    for (const r of rows) {
      const key = `${r.keywordId}:${r.regionCode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }
}
