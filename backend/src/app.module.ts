import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { ProcessingModule } from './processing/processing.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { KeywordsModule } from './modules/keywords/keywords.module';
import { RegionsModule } from './modules/regions/regions.module';
import { PositionsModule } from './modules/positions/positions.module';
import { AuditModule } from './modules/audit/audit.module';
import { SemanticsModule } from './modules/semantics/semantics.module';
import { CompetitorsModule } from './modules/competitors/competitors.module';
import { ReportsModule } from './modules/reports/reports.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    PrismaModule,
    QueueModule,
    AuthModule,
    ProjectsModule,
    KeywordsModule,
    RegionsModule,
    PositionsModule,
    AuditModule,
    SemanticsModule,
    CompetitorsModule,
    ReportsModule,
    ProcessingModule,
    TasksModule,
    DashboardModule,
  ],
})
export class AppModule {}
