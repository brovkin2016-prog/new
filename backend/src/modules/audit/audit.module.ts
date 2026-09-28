import { Module } from '@nestjs/common';
import { CrawlerService } from './crawler.service';
import { PageSpeedClient } from './pagespeed.client';
import { AuditRunner } from './audit.runner';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

@Module({
  controllers: [AuditController],
  providers: [CrawlerService, PageSpeedClient, AuditRunner, AuditService],
  exports: [AuditRunner, AuditService],
})
export class AuditModule {}
