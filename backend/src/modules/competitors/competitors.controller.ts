import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CompetitorsService } from './competitors.service';

@ApiTags('competitors')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/competitors')
export class CompetitorsController {
  constructor(private readonly service: CompetitorsService) {}

  @Get()
  list(@Param('projectId') projectId: string, @Query('clusterId') clusterId?: string) {
    return this.service.list(projectId, clusterId);
  }
}
