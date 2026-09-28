import { Module } from '@nestjs/common';
import { ProcessingService } from './processing.service';
import { PositionsModule } from '../modules/positions/positions.module';
import { AuditModule } from '../modules/audit/audit.module';
import { SemanticsModule } from '../modules/semantics/semantics.module';
import { CompetitorsModule } from '../modules/competitors/competitors.module';
import { ReportsModule } from '../modules/reports/reports.module';

@Module({
  imports: [PositionsModule, AuditModule, SemanticsModule, CompetitorsModule, ReportsModule],
  providers: [ProcessingService],
  exports: [ProcessingService],
})
export class ProcessingModule {}
