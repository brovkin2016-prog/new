import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';

class CreateProjectDto {
  @IsString() name: string;
  @IsString() domain: string;
  @IsOptional() @IsString() targetUrl?: string;
  @IsOptional() @IsArray() @IsInt({ each: true }) regionCodes?: number[];
}
class UpdateProjectDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() targetUrl?: string;
}

@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.prisma.project.findMany({ where: { userId: user.userId }, orderBy: { createdAt: 'desc' } });
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: {
        userId: user.userId,
        name: dto.name,
        domain: dto.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
        targetUrl: dto.targetUrl,
        regions: dto.regionCodes?.length
          ? { create: dto.regionCodes.map((code) => ({ regionCode: code })) }
          : undefined,
      },
    });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.project.findFirstOrThrow({
      where: { id, userId: user.userId },
      include: { regions: true, _count: { select: { keywords: true, tasks: true } } },
    });
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.prisma.project.update({ where: { id }, data: dto });
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.prisma.project.delete({ where: { id } });
  }
}
