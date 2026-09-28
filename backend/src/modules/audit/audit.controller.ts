import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AuditService } from './audit.service';

@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('runs/:runId/audit')
export class AuditController {
  constructor(private readonly service: AuditService) {}

  @Get('pages')
  pages(@Param('runId') runId: string) {
    return this.service.pages(runId);
  }

  @Get('broken-links')
  broken(@Param('runId') runId: string) {
    return this.service.brokenLinks(runId);
  }

  @Get('issues')
  issues(@Param('runId') runId: string) {
    return this.service.issues(runId);
  }
}
