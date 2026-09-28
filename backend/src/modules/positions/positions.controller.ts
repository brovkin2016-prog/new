import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PositionsService } from './positions.service';

@ApiTags('positions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/positions')
export class PositionsController {
  constructor(private readonly service: PositionsService) {}

  @Get()
  history(
    @Param('projectId') projectId: string,
    @Query('keywordId') keywordId?: string,
    @Query('regionCode') regionCode?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.history(projectId, {
      keywordId,
      regionCode: regionCode ? Number(regionCode) : undefined,
      from,
      to,
    });
  }

  @Get('latest')
  latest(@Param('projectId') projectId: string) {
    return this.service.latest(projectId);
  }
}
