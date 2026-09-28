import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ReportsService } from './reports.service';
import { ReportsExport } from './reports.export';

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('runs/:runId/report')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly exporter: ReportsExport,
  ) {}

  @Get()
  get(@Param('runId') runId: string) {
    return this.reports.get(runId);
  }

  @Get('export')
  async export(
    @Param('runId') runId: string,
    @Query('format') format: 'csv' | 'xlsx' = 'xlsx',
    @Res() res: Response,
  ) {
    const { buffer, filename, contentType } = await this.exporter.export(runId, format === 'csv' ? 'csv' : 'xlsx');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
