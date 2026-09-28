import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('regions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('regions')
export class RegionsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query('q') q?: string) {
    return this.prisma.region.findMany({
      where: q ? { name: { contains: q, mode: 'insensitive' } } : undefined,
      orderBy: { name: 'asc' },
    });
  }
}
