import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';

class CreateKeywordDto {
  @IsString() phrase: string;
  @IsOptional() @IsInt() regionCode?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}
class BulkKeywordsDto {
  @IsArray() @IsString({ each: true }) phrases: string[];
  @IsOptional() @IsInt() regionCode?: number;
}
class UpdateKeywordDto {
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsInt() regionCode?: number;
}

@ApiTags('keywords')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class KeywordsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('projects/:projectId/keywords')
  list(@Param('projectId') projectId: string) {
    return this.prisma.keyword.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }

  @Post('projects/:projectId/keywords')
  create(@Param('projectId') projectId: string, @Body() dto: CreateKeywordDto) {
    return this.prisma.keyword.create({
      data: { projectId, phrase: dto.phrase, regionCode: dto.regionCode, tags: dto.tags ?? [] },
    });
  }

  @Post('projects/:projectId/keywords/bulk')
  async bulk(@Param('projectId') projectId: string, @Body() dto: BulkKeywordsDto) {
    const data = [...new Set(dto.phrases.map((p) => p.trim()).filter(Boolean))].map((phrase) => ({
      projectId,
      phrase,
      regionCode: dto.regionCode,
    }));
    const res = await this.prisma.keyword.createMany({ data, skipDuplicates: true });
    return { added: res.count };
  }

  @Patch('keywords/:id')
  update(@Param('id') id: string, @Body() dto: UpdateKeywordDto) {
    return this.prisma.keyword.update({ where: { id }, data: dto });
  }

  @Delete('keywords/:id')
  remove(@Param('id') id: string) {
    return this.prisma.keyword.delete({ where: { id } });
  }
}
