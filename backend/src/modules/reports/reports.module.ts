import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsExport } from './reports.export';
import { ReportsController } from './reports.controller';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, ReportsExport],
  exports: [ReportsService],
})
export class ReportsModule {}
