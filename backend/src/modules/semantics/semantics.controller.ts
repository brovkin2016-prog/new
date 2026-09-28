import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { SemanticsService } from './semantics.service';

class ExpandDto {
  @IsArray() @IsString({ each: true }) markers: string[];
  @IsOptional() @IsInt() regionCode?: number;
}

@ApiTags('semantics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects/:projectId/semantics')
export class SemanticsController {
  constructor(private readonly service: SemanticsService) {}

  @Get('core')
  core(@Param('projectId') projectId: string) {
    return this.service.core(projectId);
  }

  @Post('expand')
  expand(@Param('projectId') projectId: string, @Body() dto: ExpandDto) {
    return this.service.expand(projectId, dto.markers, dto.regionCode);
  }

  @Get('gaps')
  gaps(@Param('projectId') projectId: string) {
    return this.service.gaps(projectId);
  }
}
