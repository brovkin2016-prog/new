import { Injectable, NotFoundException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';

interface ExportResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

@Injectable()
export class ReportsExport {
  constructor(private readonly prisma: PrismaService) {}

  async export(runId: string, format: 'csv' | 'xlsx'): Promise<ExportResult> {
    const run = await this.prisma.taskRun.findUnique({ where: { id: runId }, include: { task: true } });
    if (!run) throw new NotFoundException('Запуск не найден');
    const rows = await this.rowsFor(runId, run.task.type);
    return format === 'csv'
      ? this.toCsv(rows, runId)
      : this.toXlsx(rows, run.task.type, runId);
  }

  private async rowsFor(runId: string, type: string): Promise<Record<string, any>[]> {
    if (type === 'positions') {
      const r = await this.prisma.positionResult.findMany({ where: { runId }, include: { keyword: true } });
      return r.map((x) => ({ phrase: x.keyword.phrase, region: x.regionCode, position: x.position ?? '—', url: x.url ?? '' }));
    }
    if (type === 'audit') {
      const pages = await this.prisma.auditPage.findMany({ where: { runId } });
      return pages.map((p) => ({
        url: p.url,
        status: p.statusCode,
        responseMs: p.responseMs ?? '',
        lcpMs: p.lcpMs ?? '',
        title: p.title ?? '',
        issues: (p.issues as string[]).join('; '),
      }));
    }
    if (type === 'semantics') {
      const run = await this.prisma.taskRun.findUniqueOrThrow({ where: { id: runId }, include: { task: true } });
      const core = await this.prisma.semanticCore.findUnique({
        where: { projectId: run.task.projectId },
        include: { clusters: true },
      });
      return (core?.clusters ?? []).map((c) => ({
        cluster: c.name,
        intent: c.intent,
        volume: c.volume,
        potential: c.potentialTraffic,
        difficulty: c.difficulty,
        priority: Math.round(c.priority * 1000) / 1000,
        isGap: c.isGap,
      }));
    }
    // competitors
    const report = await this.prisma.report.findUnique({ where: { runId } });
    return ((report?.data as any)?.topCompetitors ?? []) as Record<string, any>[];
  }

  private toCsv(rows: Record<string, any>[], runId: string): ExportResult {
    if (!rows.length) return { buffer: Buffer.from(''), filename: `report-${runId}.csv`, contentType: 'text/csv' };
    const headers = Object.keys(rows[0]);
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))];
    return { buffer: Buffer.from('﻿' + lines.join('\n'), 'utf-8'), filename: `report-${runId}.csv`, contentType: 'text/csv; charset=utf-8' };
  }

  private async toXlsx(rows: Record<string, any>[], type: string, runId: string): Promise<ExportResult> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(type);
    if (rows.length) {
      ws.columns = Object.keys(rows[0]).map((k) => ({ header: k, key: k, width: 24 }));
      ws.addRows(rows);
      ws.getRow(1).font = { bold: true };
    }
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return {
      buffer,
      filename: `report-${runId}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
}
